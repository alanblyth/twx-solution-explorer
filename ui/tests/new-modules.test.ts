import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeScript, flattenCalls } from '../apps/explorer/src/app/js-analyzer.ts';
import { drawShape, shapeForType, SHAPE_LEGEND } from '../apps/explorer/src/app/node-shapes.ts';
import { highlightLines } from '../apps/explorer/src/app/code-tokens.ts';
import { readInheritance, dependenciesFromDefinition } from '../apps/explorer/src/app/inheritance.ts';
import { buildContainerGraph, callTargets, NO_OWNER } from '../apps/explorer/src/app/container-graph.ts';
import { layoutGraph } from '../apps/explorer/src/app/graph-layout.ts';

test('a call inside a helper records the call site and the call line', () => {
  const code = 'function find(t) {\n  return Things[t].Query();\n}\nvar x = 1;\nfind("A");';
  const [call] = flattenCalls(analyzeScript(code).steps);
  assert.deepEqual(call.lines, [5, 2]);
});

test('every legend shape draws an outline, and types map to shapes', () => {
  for (const { shape } of SHAPE_LEGEND) assert.match(drawShape(shape, 120, 40).outline, /^M/);
  assert.equal(shapeForType('DataShape'), 'hexagon');
  assert.equal(shapeForType('Thing', true), 'cylinder');
  assert.equal(shapeForType('ThingTemplates'), 'stack');
  assert.equal(shapeForType('Unheard'), 'rect');
});

test('code is split into lines of segments that rebuild the source', () => {
  const code = 'var a = "x"; // note\nif (a) { Things["B"].Go(1); }\n/* multi\nline */';
  const lines = highlightLines(code);
  assert.equal(lines.length, 4);
  assert.equal(lines.map((line) => line.map((segment) => segment.text).join('')).join('\n'), code);
  assert.ok(lines[0].some((segment) => segment.kind === 'comment'));
  assert.ok(lines[1].some((segment) => segment.kind === 'keyword' && segment.text === 'if'));
  assert.equal(highlightLines('SELECT a FROM t', 'sql')[0][0].kind, 'keyword');
  assert.equal(highlightLines('if ((', 'javascript').length, 1, 'untokenisable code still renders');
});

test('inheritance runs from the entity to the root template, with shapes per level', async () => {
  const bodies: Record<string, any> = {
    'Things/T1': { thingTemplate: 'Child', implementedShapes: { S1: {} } },
    'ThingTemplates/Child': { baseThingTemplate: 'GenericThing', implementedShapes: { S2: {} } },
    'ThingTemplates/GenericThing': { baseThingTemplate: '' },
  };
  const levels = await readInheritance(async (collection, name) => bodies[`${collection}/${name}`] ?? null, 'Things', 'T1');
  assert.deepEqual(levels.map((level) => [level.name, level.shapes.join()]), [['T1', 'S1'], ['Child', 'S2'], ['GenericThing', '']]);
});

test('a disabled Thing still shows the dependencies in its definition', () => {
  const found = dependenciesFromDefinition('Things', {
    thingTemplate: 'Stream', implementedShapes: { S: {} }, valueStream: 'VS', homeMashup: '',
    thingShape: { propertyDefinitions: { p: { aspects: { dataShape: 'DS' } }, q: { aspects: {} } } },
  });
  assert.deepEqual(found.map((item) => `${item.type}:${item.name}`), ['DataShape:DS', 'Thing:VS', 'ThingShape:S', 'ThingTemplate:Stream']);
});

test('container graph separates internal, outgoing and incoming links and groups outside owners', () => {
  const a = { name: 'A', type: 'Thing' }, b = { name: 'B', type: 'ThingTemplate' }, x = { name: 'X', type: 'DataShape' }, y = { name: 'Y', type: 'Thing' };
  const input = {
    containerKind: 'Project', containerName: 'P', members: [a, b],
    outgoing: new Map([['Thing:A', [b, x]]]), incoming: new Map([['ThingTemplate:B', [y, a]]]),
    calls: new Map([['Thing:A', [y]]]), ownerOf: (entity: { name: string }) => (entity.name === 'X' ? 'Other' : null),
    groupOutside: true, dataThings: new Set<string>(),
  };
  const graph = buildContainerGraph(input);
  assert.deepEqual(graph.links.map((link) => `${link.from.name}>${link.to.name}:${link.kind}:${link.scope}`).sort(),
    ['A>B:uses:internal', 'A>X:uses:outgoing', 'A>Y:calls:outgoing', 'Y>B:uses:incoming']);
  assert.ok(graph.nodes.some((node) => node.id === 'c:Other'));
  assert.ok(graph.nodes.some((node) => node.id === `c:${NO_OWNER}`));
  const ungrouped = buildContainerGraph({ ...input, groupOutside: false });
  assert.ok(ungrouped.groups.some((group) => group.label === 'Other'));
  const placed = layoutGraph(ungrouped.nodes, ungrouped.edges, 'LR', ungrouped.groups);
  assert.ok(placed.groups.length >= 2 && placed.groups.every((group) => group.width > 0));
});

test('call targets keep named entities and drop dynamic ones', () => {
  const calls = flattenCalls(analyzeScript('Things["A"].X(); Things[n].Y(); Resources["R"].Z(); me.W();').steps);
  assert.deepEqual(callTargets(calls).map((item) => `${item.type}:${item.name}`), ['Thing:A', 'Resource:R']);
});

test('two edges between the same nodes survive when their kinds differ', () => {
  const placed = layoutGraph([{ id: 'a', label: 'a', kind: 'x' }, { id: 'b', label: 'b', kind: 'x' }], [{ from: 'a', to: 'b', kind: 'uses' }, { from: 'a', to: 'b', kind: 'calls' }]);
  assert.equal(placed.edges.length, 2);
});
