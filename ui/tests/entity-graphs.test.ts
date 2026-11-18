import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCallGraph, buildInheritanceGraph, callEdgeKey, DERIVED_LIMIT, DERIVED_THINGS_SHOWN, derivedColumns, derivedEntities, derivedThingCount,
  inheritanceNames, layoutInheritance, missingCodeReason, visibleDerived,
} from '../apps/explorer/src/app/entity-graphs.ts';
import { layoutGraph } from '../apps/explorer/src/app/graph-layout.ts';
import type { CallTree } from '../apps/explorer/src/app/models.ts';

const levels = [
  { name: 'Pump1', type: 'Thing' as const, shapes: ['Alarmable'] },
  { name: 'Pump.TT', type: 'ThingTemplate' as const, shapes: ['Alarmable', 'Metered'] },
  { name: 'GenericThing', type: 'ThingTemplate' as const, shapes: [] },
];

test('the inheritance graph runs parent to child with shapes beside their level', () => {
  const graph = buildInheritanceGraph({ name: 'Pump1', collection: 'Things' }, levels, [], new Set());
  assert.deepEqual(graph.edges.filter((edge) => edge.kind === 'inherits').map((edge) => `${edge.from}>${edge.to}`),
    ['level:Pump.TT>level:Pump1', 'level:GenericThing>level:Pump.TT']);
  assert.equal(graph.nodes.filter((node) => node.id === 'shape:Alarmable').length, 1, 'a shared shape is one node');
  assert.deepEqual(graph.edges.filter((edge) => edge.kind === 'implements').map((edge) => edge.to), ['level:Pump1', 'level:Pump.TT', 'level:Pump.TT']);
  assert.equal(graph.nodes.find((node) => node.id === 'level:Pump1')?.kind, 'root');
  assert.equal(graph.nodes.find((node) => node.id === 'level:Pump.TT')?.shape, 'stack');
  const placed = layoutGraph(graph.nodes, graph.edges, 'TB');
  const yOf = (id: string) => placed.nodes.find((node) => node.id === id)!.y;
  assert.ok(yOf('level:GenericThing') < yOf('level:Pump.TT') && yOf('level:Pump.TT') < yOf('level:Pump1'), 'GenericThing on top');
});

test('a template shows what derives from it, at most the limit plus a "more" node', () => {
  const related = Array.from({ length: 25 }, (_, index) => ({ name: `T${String(index).padStart(2, '0')}`, type: index % 2 ? 'Thing' : 'ThingTemplate' }));
  related.push({ name: 'Ignored', type: 'Mashup' });
  const graph = buildInheritanceGraph({ name: 'Pump.TT', collection: 'ThingTemplates' }, levels.slice(1), related, new Set(['T01']), { showAllThings: true, limit: 20 });
  const derived = graph.nodes.filter((node) => node.id.startsWith('derived:') && node.id !== 'derived:more');
  assert.equal(derived.length, 20);
  assert.equal(graph.nodes.find((node) => node.id === 'derived:more')?.label, '+5 more');
  assert.equal(derived[0].sublabel, 'ThingTemplate', 'templates come first');
  assert.equal(graph.nodes.find((node) => node.id === 'derived:Thing:T01')?.shape, 'cylinder');
  assert.ok(DERIVED_LIMIT >= 200, 'the default cap allows a few hundred');
});

test('more than ten derived Things are hidden until asked for; templates always show', () => {
  const things = Array.from({ length: DERIVED_THINGS_SHOWN + 1 }, (_, index) => ({ name: `Pump${index}`, type: 'Thing' }));
  const related = [...things, { name: 'Child.TT', type: 'ThingTemplate' }];
  assert.equal(derivedThingCount(related), DERIVED_THINGS_SHOWN + 1);
  assert.deepEqual(visibleDerived(related, false).map((item) => item.name), ['Child.TT']);
  assert.equal(visibleDerived(related, true).length, DERIVED_THINGS_SHOWN + 2);
  assert.equal(visibleDerived(related.slice(1), false).length, DERIVED_THINGS_SHOWN + 1, 'ten Things still show');
  const hidden = buildInheritanceGraph({ name: 'Pump.TT', collection: 'ThingTemplates' }, levels.slice(1), related, new Set());
  assert.equal(hidden.nodes.filter((node) => node.id.startsWith('derived:')).length, 1);
  assert.equal(derivedColumns(3), 3);
  assert.equal(derivedColumns(300), 12);
});

test('a shape shows the templates and Things that implement it', () => {
  const graph = buildInheritanceGraph({ name: 'Metered', collection: 'ThingShapes' }, [{ name: 'Metered', type: 'ThingShape', shapes: [] }],
    [{ name: 'Pump.TT', type: 'ThingTemplate' }, { name: 'Pump1', type: 'Thing' }, { name: 'Pump.DS', type: 'DataShape' }], new Set());
  assert.deepEqual(graph.edges.map((edge) => `${edge.from}>${edge.to}:${edge.kind}`),
    ['level:Metered>derived:ThingTemplate:Pump.TT:implements', 'level:Metered>derived:Thing:Pump1:implements']);
  assert.equal(graph.nodes[0].shape, 'parallelogram');
});

test('inheritance names cover the chain, the shapes and what derives', () => {
  const names = inheritanceNames(levels, [{ name: 'Child', type: 'ThingTemplate' }], 'Things');
  assert.deepEqual([...names].sort(), ['ThingShape:Alarmable', 'ThingShape:Metered', 'ThingTemplate:GenericThing', 'ThingTemplate:Pump.TT']);
  assert.ok(inheritanceNames(levels.slice(1), [{ name: 'Child', type: 'ThingTemplate' }], 'ThingTemplates').has('ThingTemplate:Child'));
  assert.deepEqual(derivedEntities([{ name: 'B', type: 'Thing' }, { name: 'A', type: 'ThingTemplate' }, { name: 'B', type: 'Thing' }]).map((item) => item.name), ['A', 'B']);
});

const leaf = (collection: string, name: string, service: string, kind: CallTree['kind'], extra: Partial<CallTree> = {}): CallTree =>
  ({ entity: { collection, name }, service, kind, steps: [], ...extra });

test('the call graph collects the lines of every call from a caller to a callee', () => {
  const helper = leaf('Things', 'Store', 'Save', 'script', { code: 'x' });
  const root: CallTree = leaf('Things', 'Main', 'Run', 'script', {
    code: 'a\nb\nc\nd',
    steps: [
      { type: 'call', line: 2, lines: [2], callee: helper },
      { type: 'frame', kind: 'opt', label: 'if', line: 3, branches: [{ label: 'if', steps: [{ type: 'call', line: 4, lines: [3, 4], callee: { ...helper } }] }] },
      { type: 'call', line: 1, lines: [1], callee: leaf('Resources', 'EntityServices', 'GetEntityList', 'platform') },
    ],
  });
  const graph = buildCallGraph(root, new Set(['Store']));
  const edge = callEdgeKey('Things/Main.Run', 'Things/Store.Save');
  assert.deepEqual(graph.callLines.get(edge), [2, 3, 4]);
  assert.equal(graph.edges.find((item) => item.to === 'Things/Store.Save')?.label, '×2');
  assert.equal(graph.nodes.find((node) => node.id === 'Things/Store.Save')?.shape, 'cylinder');
  assert.equal(graph.nodes.find((node) => node.id === 'Resources/EntityServices.GetEntityList')?.shape, 'octagon');
  assert.equal(graph.nodes.find((node) => node.id === 'Things/Main.Run')?.kind, 'root');
  assert.equal(graph.services.get('Things/Main.Run'), root);
});

test('services without source say why', () => {
  assert.match(missingCodeReason(leaf('Things', 'A', 'GetPropertyValues', 'builtin')) ?? '', /Built-in/);
  assert.match(missingCodeReason(leaf('Things', 'A', 'Run', 'java')) ?? '', /Java/);
  assert.equal(missingCodeReason(leaf('Things', 'A', 'Query', 'sql', { code: 'SELECT 1' })), null);
});

test('what derives from a template is placed in rows below it', () => {
  const related = Array.from({ length: 9 }, (_, index) => ({ name: `Child${index}`, type: 'ThingTemplate' }));
  const graph = buildInheritanceGraph({ name: 'Pump.TT', collection: 'ThingTemplates' }, levels.slice(1), related, new Set());
  const placed = layoutInheritance(graph, 'level:Pump.TT', 4);
  const subject = placed.nodes.find((node) => node.id === 'level:Pump.TT')!;
  const children = placed.nodes.filter((node) => node.id.startsWith('derived:'));
  assert.equal(new Set(children.map((node) => node.y)).size, 3, 'nine children in rows of four');
  assert.ok(children.every((node) => node.y > subject.y));
  assert.ok(placed.nodes.every((node) => node.x - node.width / 2 >= 0 && node.x + node.width / 2 <= placed.width));
  assert.equal(placed.edges.filter((edge) => edge.to.startsWith('derived:')).length, 9);
});
