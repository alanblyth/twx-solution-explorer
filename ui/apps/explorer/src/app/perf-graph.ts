import type { GraphEdge, GraphGroup, GraphNode } from './graph-layout.ts';

/**
 * A synthetic graph shaped like a container scan, for timing the layout: groups of 25 nodes (like the owners of outside
 * entities), each node linked to one or two earlier nodes, often in another group. Deterministic for a given size.
 */
export function syntheticGraph(count: number): { nodes: GraphNode[]; edges: GraphEdge[]; groups: GraphGroup[] } {
  let seed = 12345;
  const random = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const groups: GraphGroup[] = [];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (let index = 0; index < count; index++) {
    const groupId = `g${Math.floor(index / 25)}`;
    if (index % 25 === 0) groups.push({ id: groupId, label: `Lab.Perf.P${groups.length}`, kind: groups.length ? 'outside' : 'inside' });
    nodes.push({ id: `n${index}`, label: `Lab.Perf.P${Math.floor(index / 25)}.T${String(index).padStart(6, '0')}`, sublabel: 'Thing', kind: 'entity', group: groupId });
    if (index > 0) {
      const links = 1 + (random() < 0.4 ? 1 : 0);
      for (let link = 0; link < links; link++) edges.push({ from: `n${index}`, to: `n${Math.floor(random() * index)}`, kind: 'uses' });
    }
  }
  return { nodes, edges, groups };
}
