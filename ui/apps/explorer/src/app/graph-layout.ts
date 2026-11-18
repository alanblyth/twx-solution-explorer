import dagre from '@dagrejs/dagre';

export interface GraphNode {
  id: string;
  label: string;
  sublabel?: string;
  /** Free-form class used by the view for colour: "root", "script", "builtin", ... */
  kind: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  kind?: string;
}

export interface PlacedNode extends GraphNode { x: number; y: number; width: number; height: number }
export interface PlacedEdge extends GraphEdge { points: { x: number; y: number }[]; labelX: number; labelY: number }
export interface PlacedGraph { nodes: PlacedNode[]; edges: PlacedEdge[]; width: number; height: number }

const CHARACTER_WIDTH = 7.2;
const NODE_PADDING = 28;
const MIN_NODE_WIDTH = 90;

export function textWidth(text: string): number {
  return Math.ceil(text.length * CHARACTER_WIDTH);
}

/** Layered layout (Sugiyama, through dagre). Cycles are handled by dagre; edges to unknown nodes are dropped. */
export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[], direction: 'LR' | 'TB' = 'LR'): PlacedGraph {
  const graph = new dagre.graphlib.Graph({ multigraph: false });
  graph.setGraph({ rankdir: direction, nodesep: 26, ranksep: 70, marginx: 20, marginy: 20 });
  graph.setDefaultEdgeLabel(() => ({}));
  const height = 46;
  for (const node of nodes) {
    const width = Math.max(MIN_NODE_WIDTH, textWidth(node.label) + NODE_PADDING, textWidth(node.sublabel ?? '') + NODE_PADDING);
    graph.setNode(node.id, { width, height: node.sublabel ? height : 36 });
  }
  const known = new Set(nodes.map((node) => node.id));
  const seen = new Set<string>();
  const kept = edges.filter((edge) => {
    const key = `${edge.from}\u0000${edge.to}`;
    if (!known.has(edge.from) || !known.has(edge.to) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const edge of kept) {
    graph.setEdge(edge.from, edge.to, { width: edge.label ? textWidth(edge.label) + 8 : 0, height: edge.label ? 16 : 0, labelpos: 'c' });
  }
  dagre.layout(graph);
  const placedNodes = nodes.map((node) => {
    const placed = graph.node(node.id);
    return { ...node, x: placed.x, y: placed.y, width: placed.width, height: placed.height };
  });
  const placedEdges = kept.map((edge) => {
    const placed = graph.edge(edge.from, edge.to);
    const points = placed.points as { x: number; y: number }[];
    const middle = points[Math.floor(points.length / 2)];
    return { ...edge, points, labelX: placed.x ?? middle.x, labelY: placed.y ?? middle.y };
  });
  const dimensions = graph.graph();
  return { nodes: placedNodes, edges: placedEdges, width: dimensions.width ?? 0, height: dimensions.height ?? 0 };
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
