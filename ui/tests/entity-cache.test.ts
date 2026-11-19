import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENTITY_CACHE_SIZE, TwxApi } from '../apps/explorer/src/app/twx-api.ts';
import { dependenciesFromDefinition } from '../apps/explorer/src/app/inheritance.ts';

/** Replaces fetch with one that answers from `answer` and counts requests per path. */
function fakePlatform(answer: (path: string) => { status: number; body?: unknown }) {
  const requests: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const path = String(url).replace('http://twx/Thingworx/', '');
    requests.push(path);
    const { status, body } = answer(path);
    return new Response(body === undefined ? '' : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { requests, restore: () => { globalThis.fetch = original; } };
}

test('an entity body is read once and shared until it is forgotten', async () => {
  const platform = fakePlatform((path) => ({ status: 200, body: { name: path } }));
  try {
    const api = new TwxApi({ baseUrl: 'http://twx/Thingworx' });
    const [first, second] = await Promise.all([api.entity('Things', 'A'), api.entity('Things', 'A')]);
    assert.equal(first, second);
    await api.entity('Things', 'A');
    assert.equal(platform.requests.length, 1);
    await api.entity('Things', 'A', { fresh: true });
    assert.equal(platform.requests.length, 2);
    await api.entity('Things', 'A');
    assert.equal(platform.requests.length, 2, 'a fresh read refreshes the cache');
    api.forgetEntities();
    await api.entity('Things', 'A');
    assert.equal(platform.requests.length, 3);
  } finally {
    platform.restore();
  }
});

test('a missing entity is remembered as null; a failed read is not kept', async () => {
  let failing = true;
  const platform = fakePlatform((path) => (path.endsWith('Gone') ? { status: 404 } : failing ? { status: 500 } : { status: 200, body: { ok: true } }));
  try {
    const api = new TwxApi({ baseUrl: 'http://twx/Thingworx' });
    assert.equal(await api.entity('Things', 'Gone'), null);
    assert.equal(await api.entity('Things', 'Gone'), null);
    await assert.rejects(api.entity('Things', 'Flaky'));
    failing = false;
    assert.deepEqual(await api.entity('Things', 'Flaky'), { ok: true });
    assert.deepEqual(platform.requests, ['Things/Gone', 'Things/Flaky', 'Things/Flaky']);
  } finally {
    platform.restore();
  }
});

test('the cache keeps the most recently used bodies only', async () => {
  const platform = fakePlatform(() => ({ status: 200, body: {} }));
  try {
    const api = new TwxApi({ baseUrl: 'http://twx/Thingworx' });
    await api.entity('Things', 'T0');
    for (let index = 1; index <= ENTITY_CACHE_SIZE; index++) {
      await api.entity('Things', `T${index}`);
      if (index === ENTITY_CACHE_SIZE - 1) await api.entity('Things', 'T0');   // T0 used again: T1 is now the oldest
    }
    const before = platform.requests.length;
    await api.entity('Things', 'T0');
    assert.equal(platform.requests.length, before, 'recently used T0 is still cached');
    await api.entity('Things', 'T1');
    assert.equal(platform.requests.length, before + 1, 'the least recently used T1 was dropped');
  } finally {
    platform.restore();
  }
});

test('a definition names what GetOutgoingDependencies lists for a Thing', () => {
  const found = dependenciesFromDefinition('Things', {
    thingTemplate: 'Stream', implementedShapes: {}, valueStream: '', homeMashup: 'Home',
    thingShape: {
      propertyDefinitions: {},
      serviceDefinitions: { Query: { resultType: { aspects: { dataShape: 'ResultDS' } }, parameterDefinitions: { filter: { aspects: { dataShape: 'FilterDS' } } } } },
      eventDefinitions: { Notice: { dataShape: 'NoticeDS' } },
    },
    configurationTables: {
      DataThingSettings: { rows: [{ persistenceProvider: 'ThingworxPersistenceProvider' }] },
      Settings: { rows: [{ dataShape: 'RowDS', runAsUser: 'Operator' }] },
      ReportingConfiguration: { dataShape: { fieldDefinitions: { reportingStrategy: { baseType: 'THINGNAME' } } }, rows: [{ reportingStrategy: 'Ignored' }] },
    },
  });
  assert.deepEqual(found.map((item) => `${item.type}:${item.name}`), [
    'DataShape:FilterDS', 'DataShape:NoticeDS', 'DataShape:ResultDS', 'DataShape:RowDS', 'Mashup:Home',
    'PersistenceProvider:ThingworxPersistenceProvider', 'ThingTemplate:Stream', 'User:Operator',
  ]);
});
