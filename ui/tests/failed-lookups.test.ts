import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlatformError, TwxApi, platformMessage, unreadableEntity } from '../apps/explorer/src/app/twx-api.ts';

/** Replaces fetch with one that answers each path from `answer`; a thrown error stands for a network failure. */
function fakePlatform(answer: (path: string) => { status: number; body: string }) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const { status, body } = answer(String(url).replace('http://twx/Thingworx/', ''));
    return new Response(body, { status, statusText: status === 500 ? 'Internal Server Error' : '' });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

const STYLE_FAILURE = 'Unable to Invoke Service GetOutgoingDependencies on DefaultMapEndStyle : Cannot invoke "com.thingworx.entities.RootEntity.getID()" because "entity" is null';

test('a lookup the platform fails with a 500 is reported as failed with its message, not thrown', async () => {
  const restore = fakePlatform((path) => (path.startsWith('StyleDefinitions/DefaultMapEndStyle/')
    ? { status: 500, body: STYLE_FAILURE }
    : { status: 200, body: JSON.stringify({ rows: [{ name: 'Lab.Used', type: 'Thing' }] }) }));
  try {
    const api = new TwxApi({ baseUrl: 'http://twx/Thingworx' });
    const failed = await api.dependencyLookup('out', 'StyleDefinition', 'DefaultMapEndStyle');
    assert.equal(failed.status, 'failed');
    assert.deepEqual(failed.items, []);
    assert.match(failed.reason ?? '', /^500: Unable to Invoke Service GetOutgoingDependencies on DefaultMapEndStyle/);
    const fine = await api.dependencyLookup('out', 'StyleDefinition', 'DefaultButtonStyle');
    assert.equal(fine.status, 'ok');
    assert.deepEqual(fine.items, [{ name: 'Lab.Used', type: 'Thing' }]);
  } finally {
    restore();
  }
});

test('a 503 that is not a disabled Thing is a failed lookup too; a disabled Thing stays not-enabled', async () => {
  const restore = fakePlatform((path) => (path.startsWith('Things/Lab.Off/')
    ? { status: 503, body: 'Thing [Lab.Off] is not enabled' }
    : { status: 503, body: 'Service Unavailable' }));
  try {
    const api = new TwxApi({ baseUrl: 'http://twx/Thingworx' });
    assert.equal((await api.dependencyLookup('out', 'Thing', 'Lab.Off')).status, 'not-enabled');
    assert.equal((await api.dependencyLookup('out', 'Thing', 'Lab.Busy')).status, 'failed');
  } finally {
    restore();
  }
});

test('a network failure still stops the scan', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
  try {
    const api = new TwxApi({ baseUrl: 'http://twx/Thingworx' });
    await assert.rejects(api.dependencyLookup('out', 'Thing', 'Lab.T'), TypeError);
  } finally {
    globalThis.fetch = original;
  }
});

test('the platform message is taken from plain text or an HTML error page and kept short', () => {
  assert.equal(platformMessage(500, 'Internal Server Error', 'Boom'), '500: Boom');
  assert.equal(platformMessage(500, 'Internal Server Error', '<html><body><h1>HTTP Status 500</h1><p>Boom</p></body></html>'), '500: HTTP Status 500 Boom');
  assert.equal(platformMessage(502, 'Bad Gateway', ''), '502: Bad Gateway');
  assert.equal(platformMessage(500, '', 'x'.repeat(400)).length, '500: '.length + 300);
  assert.ok(new PlatformError(500, 'm') instanceof Error);
});

test('an unreadable entity says why in words', () => {
  const member = { name: 'DefaultMapEndStyle', type: 'StyleDefinition' };
  assert.deepEqual(unreadableEntity(member, { items: [], status: 'failed', reason: '500: Boom' }),
    { ...member, reason: 'the platform failed: 500: Boom' });
  assert.equal(unreadableEntity(member, { items: [], status: 'not-visible' }).reason, 'not visible to you');
  assert.equal(unreadableEntity(member, { items: [], status: 'not-enabled' }).reason, 'disabled, and its definition could not be read');
});
