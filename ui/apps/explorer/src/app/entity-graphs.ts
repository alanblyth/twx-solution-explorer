import { shapeForType } from './node-shapes.ts';
import type { NodeShape } from './node-shapes.ts';
import { entityLabel, serviceId, singular } from './models.ts';
import type { CallTree, EntityRef, ResolvedStep } from './models.ts';
import { layoutGraph } from './graph-layout.ts';
import type { GraphEdge, GraphNode, PlacedEdge, PlacedGraph, PlacedNode } from './graph-layout.ts';
import type { InheritanceLevel } from './inheritance.ts';
import type { MemberEntity } from './extension-graph.ts';

/** How many templates or Things deriving from (or implementing) the subject are drawn before a "+N more" node. */
export const DERIVED_LIMIT = 300;
/** More derived Things than this are hidden until asked for; derived templates always show. */
export const DERIVED_THINGS_SHOWN = 10;

export interface InheritanceSubject { name: string; collection: string }
export interface NodeGraph { nodes: GraphNode[]; edges: GraphEdge[] }
export interface InheritanceOptions {
  /** Draw the derived Things even when there are more than DERIVED_THINGS_SHOWN. */
  showAllThings?: boolean;
  limit?: number;
}

/** Outline of a service node in a call graph, by the collection of its entity. */
export function shapeForEntity(entity: EntityRef, dataThings: Set<string>): NodeShape {
  return shapeForType(entity.collection, entity.name !== null && dataThings.has(entity.name));
}

/**
 * Inheritance of a Thing, ThingTemplate or ThingShape, for a top-to-bottom layout: the root template (GenericThing) at the top,
 * the subject below its chain, each level's shapes beside it. Edges run parent to child, so the hollow triangle drawn at the
 * edge's start sits on the parent. Below a template: what derives from it; below a shape: what implements it.
 */
export function buildInheritanceGraph(
  subject: InheritanceSubject, levels: InheritanceLevel[], related: MemberEntity[], dataThings: Set<string>,
  options: InheritanceOptions = {},
): NodeGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const levelId = (name: string): string => `level:${name}`;
  levels.forEach((level, index) => {
    const isSubject = index === 0;
    nodes.set(levelId(level.name), {
      id: levelId(level.name), label: level.name, sublabel: level.type, kind: isSubject ? 'root' : 'entity',
      shape: shapeForType(level.type, level.type === 'Thing' && dataThings.has(level.name)),
    });
    if (index > 0) edges.push({ from: levelId(level.name), to: levelId(levels[index - 1].name), kind: 'inherits' });
    for (const shapeName of level.shapes) {
      const shapeId = `shape:${shapeName}`;
      if (!nodes.has(shapeId)) nodes.set(shapeId, { id: shapeId, label: shapeName, sublabel: 'ThingShape', kind: 'entity', shape: 'parallelogram' });
      edges.push({ from: shapeId, to: levelId(level.name), kind: 'implements' });
    }
  });
  const subjectId = levels.length ? levelId(levels[0].name) : levelId(subject.name);
  if (!nodes.has(subjectId)) {
    nodes.set(subjectId, { id: subjectId, label: subject.name, sublabel: singular(subject.collection), kind: 'root', shape: shapeForType(subject.collection) });
  }
  if (subject.collection === 'ThingTemplates' || subject.collection === 'ThingShapes') {
    const edgeKind = subject.collection === 'ThingShapes' ? 'implements' : 'inherits';
    const limit = options.limit ?? DERIVED_LIMIT;
    const below = visibleDerived(related, options.showAllThings ?? false);
    for (const item of below.slice(0, limit)) {
      const id = `derived:${item.type}:${item.name}`;
      nodes.set(id, { id, label: item.name, sublabel: item.type, kind: 'incoming', shape: shapeForType(item.type, item.type === 'Thing' && dataThings.has(item.name)) });
      edges.push({ from: subjectId, to: id, kind: edgeKind });
    }
    if (below.length > limit) {
      nodes.set('derived:more', { id: 'derived:more', label: `+${below.length - limit} more`, sublabel: 'see the Used by list', kind: 'builtin', shape: 'rect' });
      edges.push({ from: subjectId, to: 'derived:more', kind: 'declared' });
    }
  }
  return { nodes: [...nodes.values()], edges };
}

/** What the inheritance graph draws below the subject: every derived template, and the Things only when few or asked for. */
export function visibleDerived(related: MemberEntity[], showAllThings: boolean): MemberEntity[] {
  const derived = derivedEntities(related);
  const thingCount = derived.filter((item) => item.type === 'Thing').length;
  return showAllThings || thingCount <= DERIVED_THINGS_SHOWN ? derived : derived.filter((item) => item.type !== 'Thing');
}

/** Number of Things deriving from (or implementing) the subject. */
export function derivedThingCount(related: MemberEntity[]): number {
  return derivedEntities(related).filter((item) => item.type === 'Thing').length;
}

/** Grid columns for derived entities: roughly twice as wide as tall, as the panel is. */
export function derivedColumns(count: number): number {
  return Math.min(12, Math.max(3, Math.ceil(Math.sqrt(count * 2))));
}

const GRID_GAP_X = 18;
const GRID_GAP_Y = 22;
const GRID_TOP_GAP = 56;

/**
 * Lays the inheritance graph out top to bottom. The chain and shapes go through dagre; what derives from the subject would all
 * share one rank and make a very wide row, so it is placed in a grid of rows below the subject instead.
 */
export function layoutInheritance(graph: NodeGraph, subjectId: string, columns?: number): PlacedGraph {
  const isDerived = (id: string): boolean => id.startsWith('derived:');
  const chain = layoutGraph(graph.nodes.filter((node) => !isDerived(node.id)), graph.edges.filter((edge) => !isDerived(edge.to)), 'TB');
  const derivedNodes = graph.nodes.filter((node) => isDerived(node.id));
  const subject = chain.nodes.find((node) => node.id === subjectId);
  if (!derivedNodes.length || !subject) return chain;
  const sized = layoutGraph(derivedNodes, [], 'TB').nodes;
  const cellWidth = Math.max(...sized.map((node) => node.width)) + GRID_GAP_X;
  const cellHeight = Math.max(...sized.map((node) => node.height)) + GRID_GAP_Y;
  const columnCount = Math.min(columns ?? derivedColumns(sized.length), sized.length);
  const gridLeft = subject.x - (columnCount * cellWidth) / 2;
  const gridTop = subject.y + subject.height / 2 + GRID_TOP_GAP;
  const placedDerived: PlacedNode[] = sized.map((node, index) => ({
    ...node,
    x: gridLeft + (index % columnCount) * cellWidth + cellWidth / 2,
    y: gridTop + Math.floor(index / columnCount) * cellHeight + node.height / 2,
  }));
  const start = { x: subject.x, y: subject.y + subject.height / 2 };
  const placedEdges: PlacedEdge[] = graph.edges.filter((edge) => isDerived(edge.to)).flatMap((edge) => {
    const target = placedDerived.find((node) => node.id === edge.to);
    if (!target) return [];
    const bend = { x: target.x, y: gridTop - GRID_TOP_GAP / 2 };
    const end = { x: target.x, y: target.y - target.height / 2 };
    return [{ ...edge, points: [start, { x: start.x, y: bend.y }, bend, end], labelX: bend.x, labelY: bend.y }];
  });
  const nodes = [...chain.nodes, ...placedDerived];
  const edges = [...chain.edges, ...placedEdges];
  const margin = 20;
  const shiftX = Math.max(0, margin - Math.min(...nodes.map((node) => node.x - node.width / 2)));
  const shift = <Point extends { x: number }>(point: Point): Point => ({ ...point, x: point.x + shiftX });
  const shiftedNodes = nodes.map(shift);
  const shiftedEdges = edges.map((edge) => ({ ...edge, labelX: edge.labelX + shiftX, points: edge.points.map(shift) }));
  return {
    nodes: shiftedNodes,
    edges: shiftedEdges,
    groups: chain.groups,
    width: Math.max(...shiftedNodes.map((node) => node.x + node.width / 2)) + margin,
    height: Math.max(...shiftedNodes.map((node) => node.y + node.height / 2)) + margin,
  };
}

/** Templates first, then Things, each by name: the entities that inherit from (or implement) the subject. */
export function derivedEntities(related: MemberEntity[]): MemberEntity[] {
  const order: Record<string, number> = { ThingTemplate: 0, Thing: 1 };
  const unique = new Map<string, MemberEntity>();
  for (const item of related) if (item.type in order) unique.set(`${item.type}:${item.name}`, item);
  return [...unique.values()].sort((left, right) => order[left.type] - order[right.type] || left.name.localeCompare(right.name));
}

/** Names drawn in the inheritance graph, to leave out of the dependency graph. */
export function inheritanceNames(levels: InheritanceLevel[], related: MemberEntity[], subjectCollection: string): Set<string> {
  const names = new Set<string>();
  levels.slice(1).forEach((level) => names.add(`ThingTemplate:${level.name}`));
  levels.forEach((level) => level.shapes.forEach((shape) => names.add(`ThingShape:${shape}`)));
  if (subjectCollection === 'ThingTemplates' || subjectCollection === 'ThingShapes') {
    derivedEntities(related).forEach((item) => names.add(`${item.type}:${item.name}`));
  }
  return names;
}

export interface CallGraphModel extends NodeGraph {
  /** Lines of the caller's code that make the calls of an edge, by `from->to`. */
  callLines: Map<string, number[]>;
  /** The most complete tree node for each service id (a recursion leaf carries no code). */
  services: Map<string, CallTree>;
}

export function callEdgeKey(from: string, to: string): string { return `${from}->${to}`; }

/** One node per distinct service, one edge per caller and callee with the call count, and the lines behind each edge. */
export function buildCallGraph(root: CallTree, dataThings: Set<string>): CallGraphModel {
  const nodes = new Map<string, GraphNode>();
  const services = new Map<string, CallTree>();
  const counts = new Map<string, number>();
  const callLines = new Map<string, number[]>();
  const order: string[] = [];
  const remember = (tree: CallTree, isRoot: boolean): void => {
    const id = serviceId(tree);
    const existing = services.get(id);
    if (!existing || (existing.kind === 'recursive' && tree.kind !== 'recursive')) {
      services.set(id, tree);
      nodes.set(id, { id, label: `${tree.service}()`, sublabel: entityLabel(tree.entity), kind: isRoot ? 'root' : tree.kind, shape: shapeForEntity(tree.entity, dataThings) });
    }
  };
  const visit = (tree: CallTree, isRoot: boolean): void => {
    remember(tree, isRoot);
    const callerId = serviceId(tree);
    walkCalls(tree.steps, (lines, callee) => {
      const key = callEdgeKey(callerId, serviceId(callee));
      const firstCall = !counts.has(key);
      if (firstCall) order.push(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const known = callLines.get(key) ?? [];
      callLines.set(key, [...new Set([...known, ...lines])].sort((left, right) => left - right));
      // A callee's own calls are counted once per caller, as in its script, not once per call site.
      if (firstCall) visit(callee, false);
      else remember(callee, false);
    });
  };
  visit(root, true);
  const edges: GraphEdge[] = order.map((key) => {
    const [from, to] = key.split('->');
    const count = counts.get(key) ?? 1;
    return { from, to, label: count > 1 ? `×${count}` : undefined };
  });
  return { nodes: [...nodes.values()], edges, callLines, services };
}

function walkCalls(steps: ResolvedStep[], visitor: (lines: number[], callee: CallTree) => void): void {
  for (const step of steps) {
    if (step.type === 'call') visitor(step.lines?.length ? step.lines : [step.line], step.callee);
    else step.branches.forEach((branch) => walkCalls(branch.steps, visitor));
  }
}

/** Why a service has no source to show, or null when it has some. */
export function missingCodeReason(tree: CallTree): string | null {
  if (typeof tree.code === 'string' && tree.code.length > 0) return null;
  switch (tree.kind) {
    case 'builtin': return 'Built-in platform service: its implementation is part of ThingWorx, so there is no source to show.';
    case 'java': return 'Java service: it is compiled into an extension, so there is no script to show.';
    case 'platform': return 'Resource or subsystem service: implemented by the platform, so there is no source to show.';
    case 'missing': return 'The entity or service was not found, or is not visible to you.';
    case 'dynamic': return 'The target is chosen at run time, so the service cannot be known.';
    case 'recursive': return 'Already on the call path; its code is shown at its first call.';
    case 'sql': return 'SQL service with no query text.';
    default: return 'This service has no script.';
  }
}
