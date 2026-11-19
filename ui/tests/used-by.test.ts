import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USED_BY_LIMIT, filterUsers, firstOfGroups, groupByType, substringMask, usedByCount } from '../apps/explorer/src/app/used-by.ts';
import { startTabOf } from '../apps/explorer/src/app/start-tab.ts';
import { TwxApi } from '../apps/explorer/src/app/twx-api.ts';

const things = (count: number, prefix = 'T') => Array.from({ length: count }, (_, index) => ({ name: `${prefix}${String(index).padStart(3, '0')}`, type: 'Thing' }));

test('Used by shows the first 10 entries across its groups', () => {
  const groups = groupByType([...things(4, 'Shape'), ...things(20)].map((item, index) => (index < 4 ? { ...item, type: 'ThingTemplate' } : item)));
  const shown = firstOfGroups(groups, USED_BY_LIMIT);
  assert.deepEqual(shown.map((group) => [group.type, group.items.length]), [['Thing', 10]]);
  const mixed = firstOfGroups(groupByType([{ name: 'A', type: 'Mashup' }, ...things(15)]), USED_BY_LIMIT);
  assert.deepEqual(mixed.map((group) => [group.type, group.items.length]), [['Mashup', 1], ['Thing', 9]]);
  assert.deepEqual(firstOfGroups(groupByType(things(3)), USED_BY_LIMIT)[0].items.length, 3);
});

test('a list at the 500-row cap is counted as 500+', () => {
  assert.equal(usedByCount(499), '499');
  assert.equal(usedByCount(500), '500+');
});

test('a name search becomes a substring mask, and * in the text is dropped', () => {
  assert.equal(substringMask(''), undefined);
  assert.equal(substringMask('  '), undefined);
  assert.equal(substringMask('T00012'), '*T00012*');
  assert.equal(substringMask('a*b'), '*ab*');
});

test('a search of a loaded list returns at most the limit and says when there are more', () => {
  const found = filterUsers(things(30), 't01', USED_BY_LIMIT);
  assert.deepEqual(found.items.map((item) => item.name), ['T010', 'T011', 'T012', 'T013', 'T014', 'T015', 'T016', 'T017', 'T018', 'T019']);
  assert.equal(found.more, false);
  assert.equal(filterUsers(things(30), '', USED_BY_LIMIT).more, true);
  assert.equal(filterUsers(things(30), 'nothing', USED_BY_LIMIT).items.length, 0);
});

test('the search of a template asks QueryImplementingThings for one more than the limit', async () => {
  const sent: { url: string; body: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
    const rows = things(11).reverse().map((item) => ({ name: item.name }));
    return new Response(JSON.stringify({ rows }), { status: 200 });
  }) as typeof fetch;
  try {
    const api = new TwxApi({ baseUrl: 'http://twx/Thingworx' });
    const found = await api.searchImplementingThings('ThingTemplates', 'Lab.Hub', 'T0', 10);
    assert.equal(sent[0].url, 'http://twx/Thingworx/ThingTemplates/Lab.Hub/Services/QueryImplementingThings');
    assert.deepEqual(sent[0].body, { maxItems: 11, nameMask: '*T0*' });
    assert.equal(found.items.length, 10);
    assert.equal(found.items[0].name, 'T000');
    assert.equal(found.more, true);
    await api.searchImplementingThings('ThingShapes', 'Lab.Shape', '', 10);
    assert.deepEqual(sent[1].body, { maxItems: 11 });
  } finally {
    globalThis.fetch = original;
  }
});

test('the start tab comes from StartTab, and anything unknown opens Extensions', () => {
  assert.equal(startTabOf('entities'), 'entities');
  assert.equal(startTabOf(' Containers '), 'containers');
  assert.equal(startTabOf(''), 'extensions');
  assert.equal(startTabOf('nonsense'), 'extensions');
  assert.equal(startTabOf(undefined), 'extensions');
});
