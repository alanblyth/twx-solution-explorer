/** An entity as ThingWorx names it: the collection it lives in ("Things") and its name. */
export interface EntityRef {
  collection: string;
  /** Null when the name cannot be known statically (for example `Things[someVariable]`). */
  name: string | null;
  /** True when the name is only partly known, e.g. "CM.GW.{gatewayName}". */
  dynamic?: boolean;
}

/** One step a script takes, in source order. */
export type Step = CallStep | FrameStep;

export interface CallStep {
  type: 'call';
  target: EntityRef;
  service: string;
  line: number;
  /** Lines that lead to the call: each local helper's call site, then the call itself. */
  lines: number[];
}

/** A structured block around calls: if/else, loop, try/catch, switch. */
export interface FrameStep {
  type: 'frame';
  kind: 'alt' | 'opt' | 'loop' | 'try';
  label: string;
  branches: { label: string; steps: Step[] }[];
  line: number;
}

export interface AnalysisResult {
  steps: Step[];
  /** Set when the script could not be parsed; the steps then come from a regular-expression fallback. */
  parseError?: string;
}

export type ServiceKind = 'script' | 'java' | 'sql' | 'builtin' | 'missing' | 'dynamic' | 'recursive' | 'limit' | 'platform';

/** A node of the resolved call tree: one service on one entity and what it goes on to call. */
export interface CallTree {
  entity: EntityRef;
  service: string;
  kind: ServiceKind;
  /** The entity that actually holds the implementation (a template for an inherited service). */
  implementedBy?: EntityRef;
  line?: number;
  steps: ResolvedStep[];
  note?: string;
  /** The implementation's source, when it can be shown. */
  code?: string;
  language?: 'javascript' | 'sql';
}

export type ResolvedStep = ResolvedCall | ResolvedFrame;

export interface ResolvedCall {
  type: 'call';
  line: number;
  lines: number[];
  callee: CallTree;
}

export interface ResolvedFrame {
  type: 'frame';
  kind: FrameStep['kind'];
  label: string;
  branches: { label: string; steps: ResolvedStep[] }[];
  line: number;
}

export interface ServiceSummary {
  name: string;
  description: string;
  /** Own service, inherited from a template or shape, or built in. */
  origin: 'own' | 'inherited' | 'builtin';
  sourceName: string;
  sourceType: string;
  handler: string;
}

export interface EntityRow {
  name: string;
  type: string;
  collection: string;
  description: string;
}

export interface PackageInfo {
  name: string;
  version: string;
  vendor: string;
  description: string;
  dependsOn: string[];
}

export function entityKey(ref: EntityRef): string {
  return `${ref.collection}/${ref.name ?? '?'}`;
}

export function entityLabel(ref: EntityRef): string {
  const name = ref.name ?? '?';
  return ref.collection === 'Things' ? name : `${singular(ref.collection)} ${name}`;
}

export function singular(collection: string): string {
  if (collection === 'Resources') return 'Resource';
  return collection.endsWith('s') ? collection.slice(0, -1) : collection;
}

/** The REST collection for an entity type name as the dependency services return it ("ThingTemplate" gives "ThingTemplates"). */
export function collectionOfType(type: string): string {
  if (type === 'Resource') return 'Resources';
  if (type === 'Directory') return 'Directories';
  if (type === 'Dashboard') return 'Dashboards';
  return type.endsWith('s') ? type : `${type}s`;
}

/** Identity of one service on one entity, used for graph nodes and code focus. */
export function serviceId(tree: CallTree): string {
  return `${entityKey(tree.entity)}.${tree.service}`;
}
