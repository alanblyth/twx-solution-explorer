import type { MemberEntity } from './extension-graph.ts';

/** One level of a template chain: the entity, and the shapes it implements directly. */
export interface InheritanceLevel { name: string; type: 'Thing' | 'ThingTemplate' | 'ThingShape'; shapes: string[] }

export type EntityReader = (collection: string, name: string) => Promise<any | null>;

const MAX_LEVELS = 30;

/**
 * The chain from an entity up to its root template (GenericThing has no base): the entity first, its template next, and so on.
 * A Thing Shape has no chain; it gets a single level.
 */
export async function readInheritance(read: EntityReader, collection: string, name: string): Promise<InheritanceLevel[]> {
  const levels: InheritanceLevel[] = [];
  const body = await read(collection, name);
  if (!body) return levels;
  if (collection === 'ThingShapes') return [{ name, type: 'ThingShape', shapes: [] }];
  levels.push({ name, type: collection === 'Things' ? 'Thing' : 'ThingTemplate', shapes: Object.keys(body.implementedShapes ?? {}).sort() });
  let base: string = collection === 'Things' ? body.thingTemplate : body.baseThingTemplate;
  const seen = new Set<string>([name]);
  while (base && !seen.has(base) && levels.length < MAX_LEVELS) {
    seen.add(base);
    const template = await read('ThingTemplates', base);
    levels.push({ name: base, type: 'ThingTemplate', shapes: Object.keys(template?.implementedShapes ?? {}).sort() });
    base = template?.baseThingTemplate ?? '';
  }
  return levels;
}

/**
 * Dependencies read from an entity's definition, for when the dependency services cannot run (a disabled Thing answers
 * 503 "is not enabled") and in place of GetOutgoingDependencies for a Thing whose body has been read anyway. Covers the
 * template, the shapes, the value stream, the home mashup, data shapes of the entity's own properties, service parameters
 * and results and events, and what its configuration names (a data Thing's persistence provider and data shape, a
 * timer's or scheduler's run-as user). On ThingWorx 10.2.1, for every Thing of a twx-dev platform, GetOutgoingDependencies
 * listed exactly these, except the home mashup, which it leaves out.
 */
export function dependenciesFromDefinition(collection: string, body: any): MemberEntity[] {
  if (!body) return [];
  const found = new Map<string, MemberEntity>();
  const add = (name: unknown, type: string): void => {
    if (typeof name === 'string' && name) found.set(`${type}:${name}`, { name, type });
  };
  add(collection === 'Things' ? body.thingTemplate : body.baseThingTemplate, 'ThingTemplate');
  for (const shape of Object.keys(body.implementedShapes ?? {})) add(shape, 'ThingShape');
  add(body.valueStream, 'Thing');
  add(body.homeMashup, 'Mashup');
  const own = body.thingShape ?? body;
  for (const property of Object.values<any>(own.propertyDefinitions ?? {})) add(property?.aspects?.dataShape, 'DataShape');
  for (const service of Object.values<any>(own.serviceDefinitions ?? {})) {
    add(service?.resultType?.aspects?.dataShape, 'DataShape');
    for (const parameter of Object.values<any>(service?.parameterDefinitions ?? {})) add(parameter?.aspects?.dataShape, 'DataShape');
  }
  for (const event of Object.values<any>(own.eventDefinitions ?? {})) add(event?.dataShape, 'DataShape');
  const tables = body.configurationTables ?? {};
  for (const row of tables.DataThingSettings?.rows ?? []) add(row?.persistenceProvider, 'PersistenceProvider');
  for (const row of tables.Settings?.rows ?? []) {
    add(row?.dataShape, 'DataShape');
    add(row?.runAsUser, 'User');
  }
  return [...found.values()].sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
}
