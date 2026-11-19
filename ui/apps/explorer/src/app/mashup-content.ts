import type { MemberEntity } from './extension-graph.ts';

/**
 * Links that only a mashup's content shows. On ThingWorx 10.2.1 the dependency services track nothing in a mashup's content,
 * for imported and built-in mashups alike (checked on twx-dev and twx-test): GetOutgoingDependencies on a mashup and
 * GetIncomingDependencies on what it uses leave out the widgets it places, the entities whose services it calls (its data
 * sources), and the mashups it contains or navigates to. `mashupContent`, a JSON string in the mashup's JSON, names them all.
 */

/** Data source entity types (Data.<id>.EntityType) and the entity type each names. Dynamic ones name what the Thing is
 * chosen from at run time (DynamicThingTemplates/GenericThing: a Thing of that template). Session and UserExtensions name none. */
const DATA_SOURCE_TYPES: Record<string, string> = {
  Things: 'Thing', ThingTemplates: 'ThingTemplate', ThingShapes: 'ThingShape', Resources: 'Resource', Subsystems: 'Subsystem',
  Menus: 'Menu', Logs: 'Log', Mashups: 'Mashup', DataShapes: 'DataShape',
  DynamicThingTemplates: 'ThingTemplate', DynamicThingShapes: 'ThingShape', DynamicSubsystems: 'Subsystem', DynamicLogs: 'Log',
};

/** Widget properties that name another mashup, per widget type, as the platform's own mashups use them. */
const MASHUP_PROPERTIES: Record<string, string[]> = {
  mashupcontainer: ['Name'], navigationfunction: ['TargetMashup'], repeater: ['Mashup'], targetmashup: ['DefaultPageMashup'],
};

/** The mashup's content as an object: `mashupContent` is a JSON string in the entity's JSON. Null when absent or not JSON. */
export function mashupContentOf(mashupBody: any): any | null {
  const content = mashupBody?.mashupContent;
  if (!content) return null;
  if (typeof content === 'object') return content;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** Every widget in the content, nested containers included, without the mashup root itself. */
function widgetsOf(content: any): any[] {
  const found: any[] = [];
  const visit = (widget: any, isRoot: boolean): void => {
    if (!widget || typeof widget !== 'object') return;
    if (!isRoot && widget.Properties) found.push(widget.Properties);
    for (const child of Array.isArray(widget.Widgets) ? widget.Widgets : []) visit(child, false);
  };
  visit(content?.UI, true);
  return found;
}

/** Every widget type the content places, without the mashup root. */
export function widgetTypesOf(content: any): string[] {
  const types = new Set(widgetsOf(content).map((properties) => properties.Type).filter((type) => typeof type === 'string' && type && type !== 'mashup'));
  return [...types].sort((left, right) => left.localeCompare(right));
}

/**
 * What a mashup uses, from its content: the widgets it places that are entities (built-ins such as flexcontainer are not:
 * Widgets/flexcontainer answers 404), its data sources, and the mashups it contains or navigates to. Itself is left out.
 */
export function mashupContentLinks(mashupBody: any, widgetEntities: ReadonlySet<string>): MemberEntity[] {
  const content = mashupContentOf(mashupBody);
  if (!content) return [];
  const found = new Map<string, MemberEntity>();
  const add = (name: unknown, type: string): void => {
    if (typeof name !== 'string' || !name.trim()) return;
    if (type === 'Mashup' && name === mashupBody?.name) return;
    found.set(`${type}:${name}`, { name, type });
  };
  for (const type of widgetTypesOf(content)) if (widgetEntities.has(type)) add(type, 'Widget');
  for (const source of Object.values<any>(content.Data ?? {})) {
    const type = DATA_SOURCE_TYPES[source?.EntityType];
    if (type) add(source.EntityName, type);
  }
  for (const properties of widgetsOf(content)) {
    for (const property of MASHUP_PROPERTIES[properties.Type] ?? []) add(properties[property], 'Mashup');
  }
  return [...found.values()].sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
}

/** Adds the links in `extra` that `items` does not hold yet (same name and type), keeping the order of `items`. */
export function withLinks(items: MemberEntity[], extra: MemberEntity[]): MemberEntity[] {
  const known = new Set(items.map((item) => `${item.type}:${item.name}`));
  return [...items, ...extra.filter((item) => !known.has(`${item.type}:${item.name}`))];
}

/** The key of an entity in `mashupsUsing`: "<type>:<name>". */
export function entityKey(type: string, name: string): string {
  return `${type}:${name}`;
}

/** Which mashups use each entity (by `entityKey`), from the mashups' bodies; mashup names in alphabetical order. */
export function mashupsUsing(mashups: { name: string; body: any }[], widgetEntities: ReadonlySet<string>): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const mashup of mashups) {
    for (const used of mashupContentLinks(mashup.body, widgetEntities)) {
      const key = entityKey(used.type, used.name);
      usage.set(key, [...(usage.get(key) ?? []), mashup.name]);
    }
  }
  for (const names of usage.values()) names.sort((left, right) => left.localeCompare(right));
  return usage;
}
