import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, edgePath } from '../apps/explorer/src/app/graph-layout.ts';
import { layoutSequence, toMermaid } from '../apps/explorer/src/app/sequence-layout.ts';
import type { CallTree } from '../apps/explorer/src/app/models.ts';

const leaf = (name: string, service: string): CallTree => ({ entity: { collection: 'Things', name }, service, kind: 'script', steps: [] });
const call = (callee: CallTree) => ({ type: 'call' as const, line: 1, lines: [1], callee });
const tree: CallTree = {
  entity: { collection: 'Things', name: 'A' }, service: 'Main', kind: 'script',
  steps: [
    call({ ...leaf('B', 'Work'), steps: [call(leaf('C', 'Deep'))] }),
    { type: 'frame', kind: 'alt', label: 'x > 1', line: 2, branches: [
      { label: 'x > 1', steps: [call(leaf('D', 'Yes'))] }, { label: 'else', steps: [call(leaf('A', 'Self'))] }] },
  ],
};

test('graph layout places nodes, drops unknown edges and cycles do not break it', () => {
  const placed = layoutGraph(
    [{ id: 'a', label: 'A', kind: 'x' }, { id: 'b', label: 'B', kind: 'x', sublabel: 'sub' }],
    [{ from: 'a', to: 'b', label: '3' }, { from: 'b', to: 'a' }, { from: 'a', to: 'zzz' }]);
  assert.equal(placed.nodes.length, 2);
  assert.equal(placed.edges.length, 2);
  assert.ok(placed.width > 0 && placed.height > 0);
  assert.match(edgePath(placed.edges[0].points), /^M/);
});

test('sequence layout: participants in first-appearance order, one message per call, frames inside the diagram', () => {
  const layout = layoutSequence(tree);
  assert.deepEqual(layout.participants.map((p) => p.label), ['A', 'B', 'C', 'D']);
  const calls = layout.messages.filter((m) => !m.dashed).map((m) => m.label);
  assert.deepEqual(calls, ['Work()', 'Deep()', 'Yes()', 'Self()']);
  assert.ok(layout.messages.some((m) => m.self), 'A calling itself is a self message');
  assert.equal(layout.frames.length, 1);
  assert.equal(layout.frames[0].dividers.length, 1);
  const ys = layout.messages.map((m) => m.y);
  assert.deepEqual([...ys].sort((l, r) => l - r), ys, 'rows run top to bottom');
  assert.ok(layout.frames[0].y2 <= layout.height);
});

test('mermaid output has participants, activations and frames', () => {
  const text = toMermaid(tree);
  assert.match(text, /^sequenceDiagram/);
  assert.match(text, /p0->>p1: Work\(\)/);
  assert.match(text, /alt x > 1/);
  assert.match(text, /else else/);
  assert.match(text, /end/);
});

test('a right-to-left layout puts what is depended on to the left of what depends on it', () => {
  const placed = layoutGraph(
    [{ id: 'App', label: 'App', kind: 'package' }, { id: 'Base', label: 'Base', kind: 'package' }, { id: 'Middle', label: 'Middle', kind: 'package' }],
    [{ from: 'App', to: 'Middle' }, { from: 'Middle', to: 'Base' }],
    'RL',
  );
  const x = (id: string) => placed.nodes.find((node) => node.id === id)!.x;
  assert.ok(x('Base') < x('Middle') && x('Middle') < x('App'));
});

test('aligned sinks put every node that depends on nothing in one leftmost column, with no gap for the anchor', () => {
  const nodes = ['App', 'Middle', 'Base', 'Shared', 'Alone'].map((id) => ({ id, label: id, kind: 'package' }));
  // App depends on Middle and Shared; Middle on Base. Base, Shared and Alone depend on nothing.
  const edges = [{ from: 'App', to: 'Middle' }, { from: 'Middle', to: 'Base' }, { from: 'App', to: 'Shared' }];
  const placed = layoutGraph(nodes, edges, 'RL', [], { alignSinks: true });
  const node = (id: string) => placed.nodes.find((item) => item.id === id)!;
  assert.equal(placed.nodes.length, 5);
  assert.equal(placed.edges.length, 3);
  for (const sink of ['Shared', 'Alone']) assert.equal(node(sink).x, node('Base').x);
  assert.ok(node('Base').x < node('Middle').x && node('Middle').x < node('App').x);
  const leftEdge = Math.min(...placed.nodes.map((item) => item.x - item.width / 2));
  assert.equal(Math.round(leftEdge), 20);
  const right = Math.max(...placed.nodes.map((item) => item.x + item.width / 2));
  assert.ok(placed.width >= right && placed.width <= right + 40);
  // Without the option an unconnected node takes the first rank instead (the right side for RL).
  const plain = layoutGraph(nodes, edges, 'RL');
  assert.notEqual(plain.nodes.find((item) => item.id === 'Alone')!.x, plain.nodes.find((item) => item.id === 'Base')!.x);
});
