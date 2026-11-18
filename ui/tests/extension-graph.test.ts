import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExtensionGraph, parseDependsOn, memberKey } from '../apps/explorer/src/app/extension-graph.ts';

const pkg = (name: string, dependsOn: string[] = []) => ({ name, version: '1.0.0', vendor: '', description: '', dependsOn });
const thing = (name: string) => ({ name, type: 'Thing' });

test('parseDependsOn keeps names only', () => {
  assert.deepEqual(parseDependsOn('A:1.0.0, B:2.1.0'), ['A', 'B']);
  assert.deepEqual(parseDependsOn(''), []);
  assert.deepEqual(parseDependsOn(undefined), []);
});

test('entity usage across packages makes an edge; same-package and unowned dependencies do not', () => {
  const members = new Map([['A', [thing('a1'), thing('a2')]], ['B', [thing('b1')]]]);
  const outgoing = new Map([
    [memberKey(thing('a1')), [thing('b1'), thing('a2'), { name: 'GenericThing', type: 'ThingTemplate' }]],
  ]);
  const graph = buildExtensionGraph([pkg('A'), pkg('B')], members, outgoing);
  assert.equal(graph.edges.length, 1);
  assert.deepEqual([graph.edges[0].from, graph.edges[0].to, graph.edges[0].declared], ['A', 'B', false]);
  assert.equal(graph.edges[0].links.length, 1);
});

test('declared dependencies are edges, and an uninstalled one is reported missing', () => {
  const graph = buildExtensionGraph([pkg('A', ['B', 'Gone']), pkg('B')], new Map(), new Map());
  assert.deepEqual(graph.edges.map((e) => [e.from, e.to, e.declared]), [['A', 'B', true]]);
  assert.deepEqual(graph.missing, ['Gone']);
});

test('declared and used together share one edge; cycles are found', () => {
  const members = new Map([['A', [thing('a1')]], ['B', [thing('b1')]]]);
  const outgoing = new Map([[memberKey(thing('a1')), [thing('b1')]], [memberKey(thing('b1')), [thing('a1')]]]);
  const graph = buildExtensionGraph([pkg('A', ['B']), pkg('B')], members, outgoing);
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.edges.find((e) => e.from === 'A')!.declared, true);
  assert.deepEqual(graph.cycles, [['A', 'B']]);
});
