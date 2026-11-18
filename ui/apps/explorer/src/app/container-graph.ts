import type { GraphEdge, GraphGroup, GraphNode } from './graph-layout.ts';
import { memberKey } from './extension-graph.ts';
import type { MemberEntity } from './extension-graph.ts';
import { shapeForType } from './node-shapes.ts';

export type LinkKind = 'uses' | 'calls';
export type LinkScope = 'internal' | 'outgoing' | 'incoming';

export interface ContainerLink { from: MemberEntity; to: MemberEntity; kind: LinkKind; scope: LinkScope; outsideOwner?: string }

export interface ContainerInput {
  /** "Project" or "Extension", and its name. */
  containerKind: string;
  containerName: string;
  members: MemberEntity[];
  /** Entities each member uses (dependency services). */
  outgoing: Map<string, MemberEntity[]>;
  /** Entities that use each member; null when not scanned. */
  incoming: Map<string, MemberEntity[]> | null;
  /** Entities each member's scripts call; null when not scanned. */
  calls: Map<string, MemberEntity[]> | null;
  /** The project or extension that holds an outside entity, or null. */
  ownerOf: (entity: MemberEntity) => string | null;
  /** Draw one node per outside project or extension instead of one per outside entity. */
  groupOutside: boolean;
  /** Data tables and streams, drawn as cylinders. */
  dataThings: Set<string>;
}

export interface ContainerGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups: GraphGroup[];
  links: ContainerLink[];
  /** Outside owners with the number of links to (out) and from (in) them. */
  outside: { owner: string; outgoing: number; incoming: number }[];
}

export const NO_OWNER = '(not in any)';
const INSIDE_GROUP = 'group:inside';

/** Relationships of the entities in one project or extension, among themselves and with everything outside it. */
export function buildContainerGraph(input: ContainerInput): ContainerGraph {
  const inside = new Set(input.members.map(memberKey));
  const links: ContainerLink[] = [];
  const add = (from: MemberEntity, to: MemberEntity, kind: LinkKind, fromInside: boolean): void => {
    if (memberKey(from) === memberKey(to)) return;
    const toInside = inside.has(memberKey(to));
    const scope: LinkScope = fromInside && toInside ? 'internal' : fromInside ? 'outgoing' : 'incoming';
    const outsideEntity = scope === 'outgoing' ? to : scope === 'incoming' ? from : null;
    links.push({ from, to, kind, scope, outsideOwner: outsideEntity ? input.ownerOf(outsideEntity) ?? NO_OWNER : undefined });
  };
  for (const member of input.members) {
    for (const used of input.outgoing.get(memberKey(member)) ?? []) add(member, used, 'uses', true);
    for (const called of input.calls?.get(memberKey(member)) ?? []) add(member, called, 'calls', true);
    for (const user of input.incoming?.get(memberKey(member)) ?? []) if (!inside.has(memberKey(user))) add(user, member, 'uses', false);
  }
  const unique = dedupe(links);

  const nodes = new Map<string, GraphNode>();
  const groups = new Map<string, GraphGroup>([[INSIDE_GROUP, { id: INSIDE_GROUP, label: `${input.containerKind} ${input.containerName}`, kind: 'inside' }]]);
  const entityNode = (entity: MemberEntity, group: string, kind: string): string => {
    const id = `e:${memberKey(entity)}`;
    if (!nodes.has(id)) {
      nodes.set(id, { id, label: entity.name, sublabel: entity.type, kind, shape: shapeForType(entity.type, input.dataThings.has(entity.name)), group });
    }
    return id;
  };
  const outsideNode = (entity: MemberEntity, owner: string): string => {
    if (input.groupOutside) {
      const id = `c:${owner}`;
      if (!nodes.has(id)) nodes.set(id, { id, label: owner, sublabel: owner === NO_OWNER ? 'platform or loose entities' : 'outside', kind: owner === NO_OWNER ? 'builtin' : 'package', shape: owner === NO_OWNER ? 'octagon' : 'folder' });
      return id;
    }
    const group = `group:${owner}`;
    if (!groups.has(group)) groups.set(group, { id: group, label: owner, kind: 'outside' });
    return entityNode(entity, group, 'builtin');
  };
  for (const member of input.members) entityNode(member, INSIDE_GROUP, 'entity');
  const counts = new Map<string, { edge: GraphEdge; count: number }>();
  const outside = new Map<string, { owner: string; outgoing: number; incoming: number }>();
  for (const link of unique) {
    const fromId = link.scope === 'incoming' ? outsideNode(link.from, link.outsideOwner!) : entityNode(link.from, INSIDE_GROUP, 'entity');
    const toId = link.scope === 'outgoing' ? outsideNode(link.to, link.outsideOwner!) : entityNode(link.to, INSIDE_GROUP, 'entity');
    const key = `${fromId}\u0000${toId}\u0000${link.kind}`;
    const entry = counts.get(key) ?? { edge: { from: fromId, to: toId, kind: link.kind }, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
    if (link.outsideOwner) {
      const tally = outside.get(link.outsideOwner) ?? { owner: link.outsideOwner, outgoing: 0, incoming: 0 };
      if (link.scope === 'outgoing') tally.outgoing += 1;
      else tally.incoming += 1;
      outside.set(link.outsideOwner, tally);
    }
  }
  const edges = [...counts.values()].map(({ edge, count }) => ({ ...edge, label: count > 1 ? String(count) : undefined }));
  return {
    nodes: [...nodes.values()], edges, groups: [...groups.values()], links: unique,
    outside: [...outside.values()].sort((left, right) => right.outgoing + right.incoming - (left.outgoing + left.incoming)),
  };
}

function dedupe(links: ContainerLink[]): ContainerLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${memberKey(link.from)}>${memberKey(link.to)}>${link.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Entity-level targets of script calls: `Things["X"]` becomes the Thing X. `me`, dynamic and unknown targets are left out. */
export function callTargets(calls: { target: { collection: string; name: string | null; dynamic?: boolean } }[]): MemberEntity[] {
  const types: Record<string, string> = { Things: 'Thing', ThingTemplates: 'ThingTemplate', ThingShapes: 'ThingShape', Resources: 'Resource', Subsystems: 'Subsystem', DataShapes: 'DataShape', Users: 'User', Groups: 'Group', Mashups: 'Mashup', Projects: 'Project' };
  const found = new Map<string, MemberEntity>();
  for (const call of calls) {
    const type = types[call.target.collection];
    if (!type || !call.target.name || call.target.dynamic) continue;
    found.set(`${type}:${call.target.name}`, { name: call.target.name, type });
  }
  return [...found.values()];
}
