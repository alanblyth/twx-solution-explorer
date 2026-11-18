import { analyzeScript, ME } from './js-analyzer.ts';
import type { CallTree, EntityRef, ResolvedStep, ServiceKind, ServiceSummary, Step } from './models.ts';
import { entityKey } from './models.ts';

/** Reads an entity's JSON (`GET /Thingworx/<collection>/<name>`). Returns null when it does not exist or the user may not see it. */
export type EntityFetcher = (collection: string, name: string) => Promise<any | null>;

export interface ResolveOptions {
  maxDepth: number;
  /** Called as each service is resolved, so the page can show progress. */
  onProgress?: (resolved: number) => void;
}

interface Implementation {
  kind: ServiceKind;
  code?: string;
  implementedBy?: EntityRef;
  handler?: string;
}

const SCRIPT_HANDLERS = new Set(['Script']);
const SQL_HANDLERS = new Set(['SQLQuery', 'SQLCommand']);
const PLATFORM_COLLECTIONS = new Set(['Resources', 'Subsystems']);
const MAX_INHERITANCE_HOPS = 12;

/**
 * Turns the calls found in a script into a tree: for every called service it fetches the implementing entity, reads the
 * script and analyses it in turn, down to `maxDepth`. Built-in (Java) services, SQL services, services that cannot be seen
 * and services whose target is not known statically are leaves.
 */
export class CallResolver {
  private readonly fetchEntity: EntityFetcher;
  private readonly entityCache = new Map<string, Promise<any | null>>();
  private resolvedCount = 0;

  constructor(fetchEntity: EntityFetcher) {
    this.fetchEntity = fetchEntity;
  }

  private entity(collection: string, name: string): Promise<any | null> {
    const key = `${collection}/${name}`;
    let found = this.entityCache.get(key);
    if (!found) {
      found = this.fetchEntity(collection, name).catch(() => null);
      this.entityCache.set(key, found);
    }
    return found;
  }

  async resolve(root: EntityRef, service: string, options: ResolveOptions): Promise<CallTree> {
    this.resolvedCount = 0;
    return this.resolveService(root, root, service, options, [], 0, 0);
  }

  private async resolveService(target: EntityRef, me: EntityRef, service: string, options: ResolveOptions, stack: string[], depth: number, line: number): Promise<CallTree> {
    const entity = target.collection === ME ? me : target;
    const node: CallTree = { entity, service, kind: 'script', steps: [], line };
    this.resolvedCount += 1;
    options.onProgress?.(this.resolvedCount);

    if (entity.name === null || entity.dynamic) {
      node.kind = 'dynamic';
      node.note = 'The target is chosen at run time';
      return node;
    }
    if (PLATFORM_COLLECTIONS.has(entity.collection)) {
      node.kind = 'platform';
      return node;
    }
    const identity = `${entityKey(entity)}.${service}`;
    if (stack.includes(identity)) {
      node.kind = 'recursive';
      return node;
    }
    const implementation = await this.findImplementation(entity, service);
    node.kind = implementation.kind;
    node.implementedBy = implementation.implementedBy;
    if (implementation.kind !== 'script' || implementation.code === undefined) return node;
    if (depth >= options.maxDepth) {
      node.kind = 'limit';
      node.note = `Depth limit of ${options.maxDepth} reached`;
      return node;
    }
    const analysis = analyzeScript(implementation.code);
    if (analysis.parseError) node.note = `Script did not parse (${analysis.parseError}); calls found by pattern match`;
    node.steps = await this.resolveSteps(analysis.steps, entity, options, [...stack, identity], depth);
    return node;
  }

  private async resolveSteps(steps: Step[], me: EntityRef, options: ResolveOptions, stack: string[], depth: number): Promise<ResolvedStep[]> {
    const resolved: ResolvedStep[] = [];
    for (const step of steps) {
      if (step.type === 'call') {
        const callee = await this.resolveService(step.target, me, step.service, options, stack, depth + 1, step.line);
        resolved.push({ type: 'call', line: step.line, callee });
      } else {
        const branches = [];
        for (const branch of step.branches) {
          branches.push({ label: branch.label, steps: await this.resolveSteps(branch.steps, me, options, stack, depth) });
        }
        resolved.push({ type: 'frame', kind: step.kind, label: step.label, branches, line: step.line });
      }
    }
    return resolved;
  }

  /** Finds where a service is implemented: on the entity, else on the template or shape the entity's effective definition names. */
  private async findImplementation(entity: EntityRef, service: string): Promise<Implementation> {
    const body = await this.entity(entity.collection, entity.name as string);
    if (!body) return { kind: 'missing' };
    const own = implementationOf(body, service);
    if (own) return { ...classify(own), implementedBy: entity, handler: own.handlerName };

    const definition = body.effectiveShape?.serviceDefinitions?.[service] ?? body.thingShape?.serviceDefinitions?.[service];
    if (!definition) return this.searchParents(body, entity, service, 0);
    if (definition.sourceType === 'ThingPackage' || definition.sourceType === 'DataShape' || !definition.sourceName) {
      return { kind: 'builtin', implementedBy: definition.sourceName ? { collection: 'ThingPackages', name: definition.sourceName } : undefined };
    }
    const sourceCollection = definition.sourceType === 'ThingShape' ? 'ThingShapes' : 'ThingTemplates';
    const source = await this.entity(sourceCollection, definition.sourceName);
    const sourceImplementation = source && implementationOf(source, service);
    if (sourceImplementation) {
      return { ...classify(sourceImplementation), implementedBy: { collection: sourceCollection, name: definition.sourceName }, handler: sourceImplementation.handlerName };
    }
    return source ? this.searchParents(source, { collection: sourceCollection, name: definition.sourceName }, service, 0) : { kind: 'missing' };
  }

  /** The definition names no usable source: walk the base template and implemented shapes. */
  private async searchParents(body: any, entity: EntityRef, service: string, hops: number): Promise<Implementation> {
    if (hops >= MAX_INHERITANCE_HOPS) return { kind: 'builtin' };
    const parents: EntityRef[] = [];
    const base = body.thingTemplate ?? body.baseThingTemplate;
    if (base) parents.push({ collection: 'ThingTemplates', name: base });
    for (const shape of Object.keys(body.implementedShapes ?? {})) parents.push({ collection: 'ThingShapes', name: shape });
    for (const parent of parents) {
      const parentBody = await this.entity(parent.collection, parent.name as string);
      if (!parentBody) continue;
      const found = implementationOf(parentBody, service);
      if (found) return { ...classify(found), implementedBy: parent, handler: found.handlerName };
      const deeper = await this.searchParents(parentBody, parent, service, hops + 1);
      if (deeper.kind !== 'builtin' && deeper.kind !== 'missing') return deeper;
    }
    return { kind: 'builtin' };
  }

  /** The services of an entity for the list the user picks from. */
  async listServices(entity: EntityRef): Promise<ServiceSummary[]> {
    const body = await this.entity(entity.collection, entity.name as string);
    if (!body) return [];
    const definitions = body.effectiveShape?.serviceDefinitions ?? body.thingShape?.serviceDefinitions ?? {};
    const implementations = body.thingShape?.serviceImplementations ?? {};
    const summaries: ServiceSummary[] = [];
    for (const [name, definition] of Object.entries<any>(definitions)) {
      const sourceType = definition.sourceType ?? 'Unknown';
      const origin: ServiceSummary['origin'] = implementations[name] || sourceType === 'Unknown' ? 'own'
        : sourceType === 'ThingPackage' || sourceType === 'DataShape' ? 'builtin' : 'inherited';
      summaries.push({
        name, description: definition.description ?? '', origin, sourceType,
        sourceName: definition.sourceName ?? '', handler: implementations[name]?.handlerName ?? '',
      });
    }
    // Own services that only appear in thingShape (an entity with no effectiveShape, such as a Thing Shape).
    for (const [name, implementation] of Object.entries<any>(implementations)) {
      if (!summaries.some((summary) => summary.name === name)) {
        summaries.push({ name, description: implementation.description ?? '', origin: 'own', sourceType: 'Unknown', sourceName: '', handler: implementation.handlerName ?? '' });
      }
    }
    const rank = { own: 0, inherited: 1, builtin: 2 } as const;
    return summaries.sort((left, right) => rank[left.origin] - rank[right.origin] || left.name.localeCompare(right.name));
  }
}

function implementationOf(body: any, service: string): any | null {
  return body?.thingShape?.serviceImplementations?.[service] ?? null;
}

function classify(implementation: any): Implementation {
  const handler: string = implementation.handlerName ?? '';
  if (SCRIPT_HANDLERS.has(handler)) {
    const code = implementation.configurationTables?.Script?.rows?.[0]?.code;
    return { kind: 'script', code: typeof code === 'string' ? code : '' };
  }
  if (SQL_HANDLERS.has(handler)) return { kind: 'sql' };
  return { kind: 'java', handler };
}

/** Distinct services reachable in a tree, for counting. */
export function countNodes(tree: CallTree): number {
  const seen = new Set<string>();
  const visit = (node: CallTree): void => {
    seen.add(`${entityKey(node.entity)}.${node.service}`);
    forEachCallee(node.steps, visit);
  };
  visit(tree);
  return seen.size;
}

export function forEachCallee(steps: ResolvedStep[], visitor: (callee: CallTree) => void): void {
  for (const step of steps) {
    if (step.type === 'call') visitor(step.callee);
    else step.branches.forEach((branch) => forEachCallee(branch.steps, visitor));
  }
}
