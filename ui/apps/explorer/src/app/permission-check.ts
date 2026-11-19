import { CallResolver } from './call-resolver.ts';
import { collectionOfType } from './models.ts';
import type { MemberEntity } from './extension-graph.ts';
import type { TwxApi } from './twx-api.ts';
import { SecurityDirectory, grantedResources, runTimeGrants, serviceIssues, summariseAccess, visibilityGrants } from './permissions.ts';
import type { AccessSummary, PermissionIssue, PermissionSource } from './permissions.ts';
import { serviceKey } from './service-usage.ts';
import type { ServiceCaller, ServiceCallIndex, UiUsageIndex } from './service-usage.ts';

/** The permissions of one service, who calls it, and its issues. */
export interface ServiceReport {
  service: string;
  /** Own, inherited from a template or shape, or built in; 'granted' for a resource only a permission names. */
  origin: 'own' | 'inherited' | 'builtin' | 'granted';
  invoke: AccessSummary;
  callers: ServiceCaller[];
  uiUsers: string[];
  issues: PermissionIssue[];
}

export interface EntityPermissionReport {
  entity: MemberEntity;
  readable: boolean;
  /** What the grants apply to: the entity itself, or a template's or shape's Things. */
  scope: string;
  visibility: AccessSummary;
  services: ServiceReport[];
  /** Sources that were read, for the panel to name ("Thing CM.Api", "Template GenericThing (its Things)", ...). */
  sources: string[];
  /** Why some answers are unknown, in words. */
  notes: string[];
}

/** What a check needs that is shared by every entity checked: read once per platform and kept until Reload. */
export interface CheckContext {
  directory: SecurityDirectory | null;
  calls: ServiceCallIndex;
  ui: UiUsageIndex;
}

/** Reads the shared context; `onProgress` hears how far the scan of every script is. */
export async function loadCheckContext(api: TwxApi, onProgress?: (done: number, total: number) => void): Promise<CheckContext> {
  const [security, calls, ui] = await Promise.all([api.securityBodies().catch(() => null), api.serviceCallIndex(onProgress), api.uiUsageIndex()]);
  return { directory: security ? new SecurityDirectory(security) : null, calls, ui };
}

const SERVICE_TYPES = new Set(['Thing', 'ThingTemplate', 'ThingShape']);

/** The permissions of an entity's services, with the two issues, read through the API's entity cache. */
export async function checkEntity(api: TwxApi, entity: MemberEntity, context: CheckContext): Promise<EntityPermissionReport> {
  const collection = collectionOfType(entity.type);
  const read = (from: string, name: string): Promise<any | null> => api.entity(from, name).catch(() => null);
  const body = await read(collection, entity.name);
  const notes: string[] = [];
  const empty = summariseAccess([], context.directory);
  if (!body) return { entity, readable: false, scope: '', visibility: empty, services: [], sources: [], notes: ['This entity could not be read: it does not exist or is not visible to you.'] };

  const sources: PermissionSource[] = [];
  // Templates and shapes whose `me` calls and dynamic mashup sources reach this entity's services.
  const relatedKeys: { collection: string; name: string }[] = [{ collection, name: entity.name }];
  let scope = `${entity.type} ${entity.name}`;
  if (entity.type === 'Thing') {
    sources.push({ label: `Thing ${entity.name}`, runTime: body.runTimePermissions, visibility: body.visibilityPermissions });
    await addChain(read, body.thingTemplate, Object.keys(body.implementedShapes ?? {}), sources, relatedKeys);
  } else if (entity.type === 'ThingTemplate') {
    scope = `the Things of template ${entity.name}`;
    sources.push({ label: `Template ${entity.name} (its Things)`, runTime: body.instanceRunTimePermissions, visibility: body.instanceVisibilityPermissions });
    await addChain(read, body.baseThingTemplate, Object.keys(body.implementedShapes ?? {}), sources, relatedKeys);
  } else if (entity.type === 'ThingShape') {
    scope = `the Things that implement shape ${entity.name}`;
    sources.push({ label: `Shape ${entity.name} (its Things)`, runTime: body.instanceRunTimePermissions, visibility: body.instanceVisibilityPermissions });
    notes.push('A shape holds no visibility for its Things; each Thing\'s own and its template\'s visibility apply.');
  } else {
    sources.push({ label: `${entity.type} ${entity.name}`, runTime: body.runTimePermissions, visibility: body.visibilityPermissions });
  }
  const collectionSource = await api.collectionPermissions(SERVICE_TYPES.has(entity.type) ? 'Things' : collection);
  if (collectionSource) sources.push(collectionSource);
  else notes.push('The collection\'s permissions could not be read, so grants on every entity of the collection are not counted.');
  if (!context.directory) notes.push('Roles, permission groups and user groups could not be read (an administrator can), so whether System holds a grant is unknown.');

  const visibility = summariseAccess(visibilityGrants(sources), context.directory);
  const services = new Map<string, ServiceReport['origin']>();
  if (SERVICE_TYPES.has(entity.type)) {
    const listed = await new CallResolver(read).listServices({ collection, name: entity.name }).catch(() => []);
    const granted = grantedResources(sources, 'ServiceInvoke');
    for (const service of listed) {
      if (service.origin !== 'builtin' || granted.has(service.name)) services.set(service.name, service.origin);
    }
  }
  for (const resource of grantedResources(sources, 'ServiceInvoke')) if (resource !== '*' && !services.has(resource)) services.set(resource, 'granted');

  const entityNames = relatedKeys.map((related) => related.name);
  const reports: ServiceReport[] = [...services].map(([service, origin]) => {
    const keys = relatedKeys.map((related) => serviceKey(related.collection, related.name, service));
    const invoke = summariseAccess(runTimeGrants(sources, 'ServiceInvoke', service), context.directory);
    const callers = context.calls.callersOf(keys);
    const uiUsers = context.ui.usersOf(keys, entityNames, service);
    return { service, origin, invoke, callers, uiUsers, issues: serviceIssues({ invoke, visibility, calledByServices: callers.length, calledFromUi: uiUsers.length }) };
  });
  reports.sort((left, right) => right.issues.length - left.issues.length || left.service.localeCompare(right.service));
  return { entity, readable: true, scope, visibility, services: reports, sources: sources.map((source) => source.label), notes };
}

/** Adds the template chain from `template` up, and the shapes of every level, as sources of their Things' grants. */
async function addChain(
  read: (collection: string, name: string) => Promise<any | null>, template: string | undefined, ownShapes: string[],
  sources: PermissionSource[], relatedKeys: { collection: string; name: string }[],
): Promise<void> {
  const shapes = new Set<string>(ownShapes);
  const seen = new Set<string>();
  let current = template;
  while (current && !seen.has(current) && seen.size < 30) {
    seen.add(current);
    const body = await read('ThingTemplates', current);
    relatedKeys.push({ collection: 'ThingTemplates', name: current });
    if (!body) break;
    sources.push({ label: `Template ${current} (its Things)`, runTime: body.instanceRunTimePermissions, visibility: body.instanceVisibilityPermissions });
    for (const shape of Object.keys(body.implementedShapes ?? {})) shapes.add(shape);
    current = body.baseThingTemplate;
  }
  for (const shape of shapes) {
    relatedKeys.push({ collection: 'ThingShapes', name: shape });
    const body = await read('ThingShapes', shape);
    if (body) sources.push({ label: `Shape ${shape} (its Things)`, runTime: body.instanceRunTimePermissions });
  }
}

/** Short text for System's access to the panel's cells. */
export function systemText(access: AccessSummary['system']): string {
  return { yes: 'yes', no: 'no', denied: 'denied', unknown: 'unknown' }[access];
}
