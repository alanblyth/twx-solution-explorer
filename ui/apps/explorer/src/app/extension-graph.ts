import type { PackageInfo } from './models.ts';

/** An entity as the extension and dependency services list it. */
export interface MemberEntity { name: string; type: string }

export interface EntityLink { fromEntity: MemberEntity; toEntity: MemberEntity }

export interface ExtensionEdge {
  from: string;
  to: string;
  /** Named in the package's `dependsOn`. */
  declared: boolean;
  /** Entities of `from` that use entities of `to`. */
  links: EntityLink[];
}

export interface ExtensionGraph {
  packages: PackageInfo[];
  /** Declared dependencies on packages that are not installed. */
  missing: string[];
  edges: ExtensionEdge[];
  /** Groups of packages that depend on each other in a circle (two or more). */
  cycles: string[][];
}

export const memberKey = (entity: MemberEntity): string => `${entity.type}:${entity.name}`;

/**
 * Combines what each package says about itself (`dependsOn`) with what its entities really use: an entity of package A that
 * depends on an entity shipped by package B makes A depend on B. Dependencies on entities no package ships (the platform, or
 * entities made by hand) are ignored.
 */
export function buildExtensionGraph(
  packages: PackageInfo[],
  membersByPackage: Map<string, MemberEntity[]>,
  outgoing: Map<string, MemberEntity[]>,
): ExtensionGraph {
  const owner = new Map<string, string>();
  for (const [packageName, members] of membersByPackage) {
    for (const member of members) owner.set(memberKey(member), packageName);
  }
  const edges = new Map<string, ExtensionEdge>();
  const edgeFor = (from: string, to: string): ExtensionEdge => {
    const key = `${from}\u0000${to}`;
    let edge = edges.get(key);
    if (!edge) {
      edge = { from, to, declared: false, links: [] };
      edges.set(key, edge);
    }
    return edge;
  };
  const installed = new Set(packages.map((item) => item.name));
  const missing = new Set<string>();
  for (const item of packages) {
    for (const dependency of item.dependsOn) {
      if (dependency === item.name) continue;
      if (installed.has(dependency)) edgeFor(item.name, dependency).declared = true;
      else missing.add(dependency);
    }
  }
  for (const [packageName, members] of membersByPackage) {
    for (const member of members) {
      for (const used of outgoing.get(memberKey(member)) ?? []) {
        const usedOwner = owner.get(memberKey(used));
        if (usedOwner && usedOwner !== packageName) edgeFor(packageName, usedOwner).links.push({ fromEntity: member, toEntity: used });
      }
    }
  }
  const edgeList = [...edges.values()].sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  return { packages, missing: [...missing].sort(), edges: edgeList, cycles: findCycles(packages.map((item) => item.name), edgeList) };
}

/** Strongly connected components with more than one package (Tarjan). */
export function findCycles(names: string[], edges: { from: string; to: string }[]): string[][] {
  const successors = new Map<string, string[]>(names.map((name) => [name, []]));
  for (const edge of edges) successors.get(edge.from)?.push(edge.to);
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];
  const connect = (name: string): void => {
    index.set(name, counter);
    low.set(name, counter);
    counter += 1;
    stack.push(name);
    onStack.add(name);
    for (const next of successors.get(name) ?? []) {
      if (!index.has(next)) {
        connect(next);
        low.set(name, Math.min(low.get(name)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(name, Math.min(low.get(name)!, index.get(next)!));
      }
    }
    if (low.get(name) === index.get(name)) {
      const group: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        group.push(member);
      } while (member !== name);
      if (group.length > 1) groups.push(group.sort());
    }
  };
  for (const name of names) if (!index.has(name)) connect(name);
  return groups;
}

/** `dependsOn` is a list such as "PackageA:1.0.0,PackageB:2.1.0"; only the names matter here. */
export function parseDependsOn(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value.split(/[,;\n]/).map((part) => part.trim().split(/[:\s]/)[0]).filter((name) => name.length > 0);
}
