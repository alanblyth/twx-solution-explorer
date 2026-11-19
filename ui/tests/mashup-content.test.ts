import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mashupContentLinks, mashupContentOf, mashupsUsing, widgetTypesOf, withLinks } from '../apps/explorer/src/app/mashup-content.ts';
import { TwxApi } from '../apps/explorer/src/app/twx-api.ts';

type WidgetSpec = { type: string; properties?: Record<string, unknown>; children?: WidgetSpec[] };

/** A mashup body as the platform returns it: mashupContent is a JSON string. */
function mashupBody(name: string, widgets: WidgetSpec[], data: Record<string, unknown> = {}): any {
  const widget = (spec: WidgetSpec): any => ({ Properties: { Type: spec.type, ...spec.properties }, Widgets: (spec.children ?? []).map(widget) });
  return { name, mashupContent: JSON.stringify({ UI: { Properties: { Type: 'mashup', MashupToEditGadget: 'DefaultMashupToEditGadget' }, Widgets: widgets.map(widget) }, Data: data }) };
}

const EXTENSION_WIDGETS = new Set(['se-explorer', 'cm-fleet', 'cm-registration-queue']);

test('every widget type is found, nested ones too, without the mashup root', () => {
  const body = mashupBody('Lab.M', [{ type: 'flexcontainer', children: [{ type: 'cm-fleet' }, { type: 'cm-registration-queue' }] }, { type: 'cm-fleet' }]);
  assert.deepEqual(widgetTypesOf(mashupContentOf(body)), ['cm-fleet', 'cm-registration-queue', 'flexcontainer']);
});

test('a mashup uses its entity widgets, its data sources and the mashups it contains or navigates to', () => {
  const body = mashupBody('Lab.Outer', [
    { type: 'flexcontainer', children: [
      { type: 'se-explorer' },
      { type: 'mashupcontainer', properties: { Name: 'Lab.Inner' } },
      { type: 'navigationfunction', properties: { TargetMashup: 'Lab.Detail' } },
      { type: 'repeater', properties: { Mashup: 'Lab.Row' } },
      { type: 'targetmashup', properties: { DefaultPageMashup: 'Lab.Home' } },
      { type: 'mashupcontainer', properties: { Name: 'Lab.Outer' } },
      { type: 'ptcslabel', properties: { Name: 'not a mashup property here' } },
    ] },
  ], {
    first: { EntityType: 'Things', EntityName: 'Lab.Data' },
    second: { EntityType: 'Resources', EntityName: 'EntityServices' },
    third: { EntityType: 'DynamicThingTemplates', EntityName: 'GenericThing' },
    fourth: { EntityType: 'Session', EntityName: '' },
    fifth: { EntityType: 'UserExtensions' },
  });
  assert.deepEqual(mashupContentLinks(body, EXTENSION_WIDGETS).map((item) => `${item.type}:${item.name}`), [
    'Mashup:Lab.Detail', 'Mashup:Lab.Home', 'Mashup:Lab.Inner', 'Mashup:Lab.Row',
    'Resource:EntityServices', 'Thing:Lab.Data', 'ThingTemplate:GenericThing', 'Widget:se-explorer',
  ]);
});

test('built-in widgets, the root gadget and the mashup itself are not links', () => {
  const body = mashupBody('Lab.M', [{ type: 'flexcontainer', children: [{ type: 'ptcslabel' }] }]);
  assert.deepEqual(mashupContentLinks(body, EXTENSION_WIDGETS), []);
});

test('content that is missing, an object, or not JSON is handled', () => {
  assert.equal(mashupContentOf({}), null);
  assert.equal(mashupContentOf({ mashupContent: '{not json' }), null);
  assert.deepEqual(mashupContentOf({ mashupContent: { UI: {} } }), { UI: {} });
  assert.deepEqual(mashupContentLinks(null, EXTENSION_WIDGETS), []);
});

test('extra links are added once, after the ones the platform listed', () => {
  const listed = [{ name: 'Lab.T', type: 'Thing' }, { name: 'se-explorer', type: 'Widget' }];
  assert.deepEqual(withLinks(listed, [{ name: 'se-explorer', type: 'Widget' }, { name: 'cm-fleet', type: 'Widget' }]),
    [...listed, { name: 'cm-fleet', type: 'Widget' }]);
});

test('which mashups use each entity', () => {
  const usage = mashupsUsing([
    { name: 'Lab.B', body: mashupBody('Lab.B', [{ type: 'cm-fleet' }], { data: { EntityType: 'Things', EntityName: 'Lab.Data' } }) },
    { name: 'Lab.A', body: mashupBody('Lab.A', [{ type: 'cm-fleet' }, { type: 'mashupcontainer', properties: { Name: 'Lab.B' } }]) },
    { name: 'Lab.Empty', body: null },
  ], EXTENSION_WIDGETS);
  assert.deepEqual(Object.fromEntries(usage), { 'Widget:cm-fleet': ['Lab.A', 'Lab.B'], 'Thing:Lab.Data': ['Lab.B'], 'Mashup:Lab.B': ['Lab.A'] });
});

test('the API gives a mashup its content links and any entity the mashups using it, reading the mashups once', async () => {
  const requests: string[] = [];
  const bodies: Record<string, any> = {
    'Mashups/Lab.Fleet': mashupBody('Lab.Fleet', [{ type: 'flexcontainer', children: [{ type: 'cm-fleet' }] }], { data: { EntityType: 'Things', EntityName: 'Lab.Data' } }),
    'Mashups/Lab.Explorer': mashupBody('Lab.Explorer', [{ type: 'se-explorer' }, { type: 'mashupcontainer', properties: { Name: 'Lab.Fleet' } }]),
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const path = String(url).replace('http://twx/Thingworx/', '');
    requests.push(path);
    if (path.startsWith('Widgets?')) return new Response(JSON.stringify({ rows: [{ name: 'cm-fleet' }, { name: 'se-explorer' }] }), { status: 200 });
    if (path.startsWith('Mashups?')) return new Response(JSON.stringify({ rows: [{ name: 'Lab.Fleet' }, { name: 'Lab.Explorer' }] }), { status: 200 });
    return bodies[path] ? new Response(JSON.stringify(bodies[path]), { status: 200 }) : new Response('', { status: 404 });
  }) as typeof fetch;
  try {
    const api = new TwxApi({ baseUrl: 'http://twx/Thingworx' });
    assert.deepEqual(await api.contentLinks('out', 'Mashup', 'Lab.Fleet'), [{ name: 'Lab.Data', type: 'Thing' }, { name: 'cm-fleet', type: 'Widget' }]);
    assert.deepEqual(await api.contentLinks('in', 'Widget', 'cm-fleet'), [{ name: 'Lab.Fleet', type: 'Mashup' }]);
    assert.deepEqual(await api.contentLinks('in', 'Thing', 'Lab.Data'), [{ name: 'Lab.Fleet', type: 'Mashup' }]);
    assert.deepEqual(await api.contentLinks('in', 'Mashup', 'Lab.Fleet'), [{ name: 'Lab.Explorer', type: 'Mashup' }]);
    assert.deepEqual(await api.contentLinks('out', 'Thing', 'Lab.Data'), []);
    assert.equal(requests.filter((path) => path === 'Mashups/Lab.Explorer').length, 1, 'each mashup read once for the usage map');
    api.forgetEntities();
    await api.contentLinks('in', 'Widget', 'cm-fleet');
    assert.equal(requests.filter((path) => path === 'Mashups/Lab.Explorer').length, 2, 'Reload reads them again');
  } finally {
    globalThis.fetch = original;
  }
});
