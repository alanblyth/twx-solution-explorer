// Runs the app's own pure logic in node (type stripping) for the performance harness, and prints one JSON line.
//
//   node --experimental-strip-types tools/perf/node_bench.ts trace <Things|ThingTemplates|ThingShapes> <entity> <service> <depth>
//   node --experimental-strip-types tools/perf/node_bench.ts layout <node count> [grouped runs, default 3, 1 from 1,000 nodes]
//
// trace: CallResolver, the resolver the Entities tab uses, with a fetch-based EntityFetcher against TWX_BASE (Basic
// authentication once, then the session cookie, as the browser would). Reports wall time, requests, bytes, tree size.
// layout: layoutGraph (dagre) on a layered graph shaped like a container scan (groups and cross links), median of 3 runs.
import { readFileSync } from 'node:fs';
import { CallResolver } from '../../ui/apps/explorer/src/app/call-resolver.ts';
import { layoutGraph } from '../../ui/apps/explorer/src/app/graph-layout.ts';
import { syntheticGraph } from '../../ui/apps/explorer/src/app/perf-graph.ts';
import type { CallTree } from '../../ui/apps/explorer/src/app/models.ts';

const [command, ...rest] = process.argv.slice(2);

function countNodes(tree: CallTree): { nodes: number; deepest: number; kinds: Record<string, number> } {
  const kinds: Record<string, number> = {};
  let nodes = 0;
  let deepest = 0;
  const visit = (node: CallTree, depth: number): void => {
    nodes += 1;
    deepest = Math.max(deepest, depth);
    kinds[node.kind] = (kinds[node.kind] ?? 0) + 1;
    const walk = (steps: any[]): void => {
      for (const step of steps) {
        if (step.type === 'call') visit(step.callee, depth + 1);
        else for (const branch of step.branches) walk(branch.steps);
      }
    };
    walk(node.steps);
  };
  visit(tree, 0);
  return { nodes, deepest, kinds };
}

async function trace(collection: string, entity: string, service: string, depth: number): Promise<void> {
  const base = (process.env.TWX_BASE ?? '').replace(/\/+$/, '');
  if (!/^http:\/\/(localhost|127\.0\.0\.1):18080\//.test(`${base}/`)) throw new Error(`refusing ${base}: twx-test on localhost:18080 only`);
  const password = readFileSync(process.env.TWX_ADMIN_PASSWORD_FILE ?? '', 'utf8').trim();
  let cookie = '';
  let requests = 0;
  let bytes = 0;
  let waiting = 0;
  const fetchEntity = async (entityCollection: string, name: string): Promise<any | null> => {
    const headers: Record<string, string> = { Accept: 'application/json', 'X-XSRF-TOKEN': 'TWX-XSRF-TOKEN-VALUE' };
    if (cookie) headers.Cookie = cookie;
    else headers.Authorization = `Basic ${Buffer.from(`Administrator:${password}`).toString('base64')}`;
    const started = performance.now();
    const response = await fetch(`${base}/${entityCollection}/${encodeURIComponent(name)}`, { headers });
    const text = await response.text();
    waiting += performance.now() - started;
    requests += 1;
    bytes += Buffer.byteLength(text);
    const session = response.headers.get('set-cookie')?.match(/JSESSIONID=[^;]+/);
    if (session && !cookie) cookie = session[0];
    return response.ok && text.trim() ? JSON.parse(text) : null;
  };
  const resolver = new CallResolver(fetchEntity);
  const started = performance.now();
  const tree = await resolver.resolve({ collection, name: entity }, service, { maxDepth: depth });
  const seconds = (performance.now() - started) / 1000;
  const memory = process.memoryUsage();
  console.log(JSON.stringify({ scenario: 'trace', entity, service, depth, seconds, requests, bytes, request_seconds: waiting / 1000,
    tree: countNodes(tree), tree_json_bytes: Buffer.byteLength(JSON.stringify(tree)), heap_used_mb: Math.round(memory.heapUsed / 1048576) }));
}

function layout(count: number, groupedRuns: number): void {
  // The grouped (compound) layout grows much faster than the plain one, so large sizes take one grouped run.
  const { nodes, edges, groups } = syntheticGraph(count);
  const time = (work: () => void, runs: number): number => {
    const timings: number[] = [];
    for (let run = 0; run < runs; run++) {
      const started = performance.now();
      work();
      timings.push(performance.now() - started);
    }
    timings.sort((left, right) => left - right);
    return Math.round(timings[Math.floor(timings.length / 2)]);
  };
  const ungroupedMilliseconds = time(() => layoutGraph(nodes.map((node) => ({ ...node, group: undefined })), edges, 'LR'), 3);
  const groupedMilliseconds = groupedRuns > 0 ? time(() => layoutGraph(nodes, edges, 'LR', groups), groupedRuns) : null;
  console.log(JSON.stringify({ scenario: 'layout', nodes: count, edges: edges.length, groups: groups.length, grouped_runs: groupedRuns,
    grouped_ms_median: groupedMilliseconds, ungrouped_ms_median: ungroupedMilliseconds }));
}

if (command === 'trace') await trace(rest[0], rest[1], rest[2], Number(rest[3]));
else if (command === 'layout') layout(Number(rest[0]), Number(rest[1] ?? (Number(rest[0]) >= 1000 ? 1 : 3)));
else { console.error('usage: trace <collection> <entity> <service> <depth> | layout <nodes>'); process.exit(2); }
