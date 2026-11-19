import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perfClear, perfEntries, perfStart, perfSync, setPerfEnabled } from '../apps/explorer/src/app/perf.ts';
import { layoutGraph } from '../apps/explorer/src/app/graph-layout.ts';
import { syntheticGraph } from '../apps/explorer/src/app/perf-graph.ts';

test('perf marks record nothing while the flag is off', () => {
  setPerfEnabled(false);
  perfClear();
  perfSync('test:off', () => 1);
  perfStart('test:off-start')();
  assert.equal(perfEntries().length, 0);
});

test('perf marks record named measures with their detail when on', () => {
  setPerfEnabled(true);
  perfClear();
  const value = perfSync('test:work', () => 42, (result) => ({ result }));
  const end = perfStart('test:phase', { members: 3 });
  end({ done: true });
  layoutGraph(syntheticGraph(30).nodes, syntheticGraph(30).edges);
  const entries = perfEntries();
  assert.equal(value, 42);
  assert.deepEqual(entries.map((entry) => entry.name), ['test:work', 'test:phase', 'layout']);
  assert.deepEqual(entries[0].detail, { result: 42 });
  assert.deepEqual(entries[1].detail, { members: 3, done: true });
  assert.equal(entries[2].detail.nodes, 30);
  perfClear();
  assert.equal(perfEntries().length, 0);
  setPerfEnabled(false);
});

test('the synthetic graph is deterministic and grouped by 25', () => {
  const first = syntheticGraph(100);
  const second = syntheticGraph(100);
  assert.deepEqual(first, second);
  assert.equal(first.groups.length, 4);
  assert.ok(first.edges.every((edge) => Number(edge.to.slice(1)) < Number(edge.from.slice(1))));
});
