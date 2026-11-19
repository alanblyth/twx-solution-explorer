import dagre from '@dagrejs/dagre';
import { shapeExtraWidth } from './node-shapes.ts';
import type { NodeShape } from './node-shapes.ts';
import { perfStart } from './perf.ts';

export interface GraphNode {
  id: string;
  label: string;
  sublabel?: string;
  /** Colour class: "root", "script", "builtin", ... */
  kind: string;
  /** Outline by entity type; a rounded box when left out. */
  shape?: NodeShape;
  /** Id of the group (cluster) the node is drawn inside. */
  group?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  /** "uses", "calls", "declared", "inherits", "implements", ... Two edges between the same nodes are kept if their kinds differ. */
  kind?: string;
}

export interface GraphGroup { id: string; label: string; kind: string }

export interface PlacedNode extends GraphNode { x: number; y: number; width: number; height: number }
export interface PlacedEdge extends GraphEdge { points: { x: number; y: number }[]; labelX: number; labelY: number }
export interface PlacedGroup extends GraphGroup { x: number; y: number; width: number; height: number }
export interface PlacedGraph { nodes: PlacedNode[]; edges: PlacedEdge[]; groups: PlacedGroup[]; width: number; height: number }

export const EMPTY_GRAPH: PlacedGraph = { nodes: [], edges: [], groups: [], width: 0, height: 0 };

const CHARACTER_WIDTH = 7.2;
const NODE_PADDING = 28;
const MIN_NODE_WIDTH = 90;

export function textWidth(text: string): number {
  return Math.ceil(text.length * CHARACTER_WIDTH);
}

export function edgeKey(edge: GraphEdge): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.kind ?? ''}`;
}

export interface LayoutOptions {
  /**
   * Put every node with no outgoing edge in the last rank (with 'RL', the leftmost column), unconnected nodes included.
   * Dagre otherwise ranks such a node next to whatever points at it, and an unconnected node in the first rank.
   */
  alignSinks?: boolean;
}

/** A hidden node the sinks are tied to when `alignSinks` is set; never drawn. */
const SINK_ANCHOR = '\u0000sink-anchor';

/** Layered layout (Sugiyama, through dagre), with optional groups. Edges to unknown nodes are dropped. */
export function layoutGraph(
  nodes: GraphNode[], edges: GraphEdge[], direction: 'LR' | 'RL' | 'TB' | 'BT' = 'LR', groups: GraphGroup[] = [], options: LayoutOptions = {},
): PlacedGraph {
  const end = perfStart('layout', { nodes: nodes.length, edges: edges.length, groups: groups.length });
  const placed = placeGraph(nodes, edges, direction, groups, options);
  end();
  return placed;
}

function placeGraph(nodes: GraphNode[], edges: GraphEdge[], direction: 'LR' | 'RL' | 'TB' | 'BT', groups: GraphGroup[], options: LayoutOptions): PlacedGraph {
  const graph = new dagre.graphlib.Graph({ multigraph: true, compound: groups.length > 0 });
  graph.setGraph({ rankdir: direction, nodesep: 26, ranksep: 70, marginx: 20, marginy: 28 });
  graph.setDefaultEdgeLabel(() => ({}));
  const usedGroups = groups.filter((group) => nodes.some((node) => node.group === group.id));
  for (const group of usedGroups) graph.setNode(group.id, { label: group.label, paddingTop: 30, paddingLeft: 14, paddingRight: 14, paddingBottom: 14 });
  for (const node of nodes) {
    const extra = shapeExtraWidth(node.shape ?? 'rounded');
    const width = Math.max(MIN_NODE_WIDTH, textWidth(node.label) + NODE_PADDING + extra, textWidth(node.sublabel ?? '') + NODE_PADDING + extra);
    graph.setNode(node.id, { width, height: node.sublabel ? 48 : 38 });
    if (node.group && usedGroups.some((group) => group.id === node.group)) graph.setParent(node.id, node.group);
  }
  const known = new Set(nodes.map((node) => node.id));
  const seen = new Set<string>();
  const kept = edges.filter((edge) => {
    const key = edgeKey(edge);
    if (!known.has(edge.from) || !known.has(edge.to) || edge.from === edge.to || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const edge of kept) {
    graph.setEdge(edge.from, edge.to, { width: edge.label ? textWidth(edge.label) + 8 : 0, height: edge.label ? 16 : 0, labelpos: 'c' }, edge.kind || 'link');
  }
  const anchored = Boolean(options.alignSinks) && nodes.length > 0;
  if (anchored) {
    // Each sink gets a heavy edge to one hidden node, so the ranker keeps them all one rank before it: one column.
    const hasOutgoing = new Set(kept.map((edge) => edge.from));
    graph.setNode(SINK_ANCHOR, { width: 1, height: 1 });
    for (const node of nodes) {
      if (!hasOutgoing.has(node.id)) graph.setEdge(node.id, SINK_ANCHOR, { width: 0, height: 0, weight: 1000, minlen: 1 }, 'anchor');
    }
  }
  dagre.layout(graph);
  const placedNodes = nodes.map((node) => {
    const placed = graph.node(node.id);
    return { ...node, x: placed.x, y: placed.y, width: placed.width, height: placed.height };
  });
  const placedEdges = kept.map((edge) => {
    const placed = graph.edge({ v: edge.from, w: edge.to, name: edge.kind || 'link' });
    const points = placed.points as { x: number; y: number }[];
    const middle = points[Math.floor(points.length / 2)];
    return { ...edge, points, labelX: placed.x ?? middle.x, labelY: placed.y ?? middle.y };
  });
  const placedGroups = usedGroups.map((group) => {
    const placed = graph.node(group.id);
    return { ...group, x: placed.x, y: placed.y, width: placed.width, height: placed.height };
  });
  const dimensions = graph.graph();
  const placedGraph = { nodes: placedNodes, edges: placedEdges, groups: placedGroups, width: dimensions.width ?? 0, height: dimensions.height ?? 0 };
  return anchored ? withoutAnchorSpace(placedGraph) : placedGraph;
}

/** Moves a graph laid out with the hidden anchor back to the margins, so the anchor's empty rank leaves no gap. */
function withoutAnchorSpace(graph: PlacedGraph): PlacedGraph {
  const margin = { x: 20, y: 28 };
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const include = (x: number, y: number, halfWidth = 0, halfHeight = 0): void => {
    left = Math.min(left, x - halfWidth);
    right = Math.max(right, x + halfWidth);
    top = Math.min(top, y - halfHeight);
    bottom = Math.max(bottom, y + halfHeight);
  };
  for (const node of graph.nodes) include(node.x, node.y, node.width / 2, node.height / 2);
  for (const group of graph.groups) include(group.x, group.y, group.width / 2, group.height / 2);
  for (const edge of graph.edges) {
    for (const point of edge.points) include(point.x, point.y);
    include(edge.labelX, edge.labelY);
  }
  if (!Number.isFinite(left)) return graph;
  const shiftX = margin.x - left;
  const shiftY = margin.y - top;
  return {
    nodes: graph.nodes.map((node) => ({ ...node, x: node.x + shiftX, y: node.y + shiftY })),
    groups: graph.groups.map((group) => ({ ...group, x: group.x + shiftX, y: group.y + shiftY })),
    edges: graph.edges.map((edge) => ({
      ...edge, points: edge.points.map((point) => ({ x: point.x + shiftX, y: point.y + shiftY })), labelX: edge.labelX + shiftX, labelY: edge.labelY + shiftY,
    })),
    width: right - left + margin.x * 2,
    height: bottom - top + margin.y * 2,
  };
}

/** A smooth SVG path through the edge points, ending on the last point (the arrow head). */
export function edgePath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return '';
  if (points.length === 2) return `M${points[0].x},${points[0].y} L${points[1].x},${points[1].y}`;
  let path = `M${points[0].x},${points[0].y}`;
  for (let index = 1; index < points.length - 1; index++) {
    const middleX = (points[index].x + points[index + 1].x) / 2;
    const middleY = (points[index].y + points[index + 1].y) / 2;
    path += ` Q${points[index].x},${points[index].y} ${middleX},${middleY}`;
  }
  const last = points[points.length - 1];
  return `${path} L${last.x},${last.y}`;
}
