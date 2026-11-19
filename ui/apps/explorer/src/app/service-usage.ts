import { analyzeScript, flattenCalls, ME } from './js-analyzer.ts';
import { mashupContentOf } from './mashup-content.ts';

/**
 * Who calls a service: other services (from their scripts) and the user interface (mashup data sources, and the
 * JavaScript of extension widgets, which is where an Angular app's REST calls live). No Angular here.
 */

/** The key of one service on one entity: "<collection>/<name>.<service>". */
export function serviceKey(collection: string, name: string, service: string): string {
  return `${collection}/${name}.${service}`;
}

export interface ServiceCaller { collection: string; name: string; service: string }

/** A script holder: a Thing, template or shape and its JSON. */
export interface ScriptHolder { collection: string; name: string; body: any }

const SCRIPT_HANDLERS = new Set(['Script']);

/** Every service each script service of the holder calls, as service keys. `me` calls name the holder itself. */
export function callsOfHolder(holder: ScriptHolder): { caller: ServiceCaller; key: string }[] {
  const implementations: Record<string, any> = holder.body?.thingShape?.serviceImplementations ?? holder.body?.serviceImplementations ?? {};
  const found: { caller: ServiceCaller; key: string }[] = [];
  for (const [service, implementation] of Object.entries<any>(implementations)) {
    if (!SCRIPT_HANDLERS.has(implementation?.handlerName)) continue;
    const code = implementation.configurationTables?.Script?.rows?.[0]?.code;
    if (typeof code !== 'string' || !code.trim()) continue;
    const caller = { collection: holder.collection, name: holder.name, service };
    const seen = new Set<string>();
    for (const call of flattenCalls(analyzeScript(code).steps)) {
      const self = call.target.collection === ME;
      const collection = self ? holder.collection : call.target.collection;
      const name = self ? holder.name : call.target.name;
      if (!name || call.target.dynamic) continue;
      const key = serviceKey(collection, name, call.service);
      if (key === serviceKey(holder.collection, holder.name, service) || seen.has(key)) continue;   // recursion is not a caller
      seen.add(key);
      found.push({ caller, key });
    }
  }
  return found;
}

/** Which services call each service, from the scripts of every Thing, template and shape read. */
export class ServiceCallIndex {
  private readonly callers = new Map<string, ServiceCaller[]>();
  /** How many holders were read, and how many could not be. */
  holders = 0;
  unreadable = 0;

  add(holder: ScriptHolder): void {
    this.holders += 1;
    for (const { caller, key } of callsOfHolder(holder)) {
      const list = this.callers.get(key) ?? [];
      list.push(caller);
      this.callers.set(key, list);
    }
  }

  /** Callers of any of the keys, without duplicates, in name order. */
  callersOf(keys: string[]): ServiceCaller[] {
    const found = new Map<string, ServiceCaller>();
    for (const key of keys) for (const caller of this.callers.get(key) ?? []) found.set(serviceKey(caller.collection, caller.name, caller.service), caller);
    return [...found.values()].sort((left, right) => left.name.localeCompare(right.name) || left.service.localeCompare(right.service));
  }
}

/** Data source entity types and the collection a service key uses; dynamic ones name a template or shape of the Thing. */
const SOURCE_COLLECTIONS: Record<string, string> = {
  Things: 'Things', ThingTemplates: 'ThingTemplates', ThingShapes: 'ThingShapes', Resources: 'Resources', Subsystems: 'Subsystems',
  DynamicThingTemplates: 'ThingTemplates', DynamicThingShapes: 'ThingShapes', DynamicSubsystems: 'Subsystems',
};

/** The services a mashup's data sources call, as service keys. */
export function mashupServiceKeys(mashupBody: any): string[] {
  const content = mashupContentOf(mashupBody);
  const keys = new Set<string>();
  for (const source of Object.values<any>(content?.Data ?? {})) {
    const collection = SOURCE_COLLECTIONS[source?.EntityType];
    if (!collection || typeof source.EntityName !== 'string' || !source.EntityName) continue;
    for (const service of source.Services ?? []) {
      const name = service?.Name ?? service?.Target;
      if (typeof name === 'string' && name) keys.add(serviceKey(collection, source.EntityName, name));
    }
  }
  return [...keys];
}

/** A JavaScript file of an extension widget, with a label such as "widget cm-fleet (cm-elements.js)". */
export interface ScriptFile { label: string; text: string }

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a widget's JavaScript calls the service, by text: the file names the entity (quoted or in a path) and the service
 * as a string or a `/Services/<name>` path. It is a heuristic: minified Angular builds the URL at run time, so the names are
 * all there is to match.
 */
export function scriptNamesService(text: string, entityNames: string[], service: string): boolean {
  const serviceMatch = new RegExp(`(?:["'\`]|/Services/)${escapeRegExp(service)}(?![\\w$])`);
  if (!serviceMatch.test(text)) return false;
  return entityNames.some((entity) => new RegExp(`["'\`/]${escapeRegExp(entity)}(?:["'\`/]|$)`, 'm').test(text));
}

/** The JavaScript files a widget runtime loads besides itself: script URLs under /Common/extensions/ that it names. */
export function referencedScripts(runtimeText: string): string[] {
  const found = new Set<string>();
  for (const match of runtimeText.matchAll(/["'`](\/Thingworx\/Common\/extensions\/[^"'`\s]+\.js)["'`]/g)) found.add(match[1]);
  return [...found];
}

/** Which mashups and widget scripts call each service. */
export class UiUsageIndex {
  private readonly mashups = new Map<string, string[]>();
  readonly scripts: ScriptFile[] = [];
  mashupCount = 0;

  addMashup(name: string, body: any): void {
    this.mashupCount += 1;
    for (const key of mashupServiceKeys(body)) this.mashups.set(key, [...(this.mashups.get(key) ?? []), name]);
  }

  addScript(file: ScriptFile): void {
    this.scripts.push(file);
  }

  /** What calls the service from the user interface: "mashup <name>" and "<script label>" entries. */
  usersOf(keys: string[], entityNames: string[], service: string): string[] {
    const found = new Set<string>();
    for (const key of keys) for (const mashup of this.mashups.get(key) ?? []) found.add(`mashup ${mashup}`);
    for (const script of this.scripts) if (scriptNamesService(script.text, entityNames, service)) found.add(script.label);
    return [...found].sort((left, right) => left.localeCompare(right));
  }
}
