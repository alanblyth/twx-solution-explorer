/**
 * Who may run a service, read from entity JSON, and the two permission issues the explorer flags. No Angular here, so
 * `npm test` can run it.
 *
 * Where grants live (ThingWorx 10.2.1, read on twx-dev): an entity's `runTimePermissions.permissions` lists, per resource
 * (`resourceName` is a service name or `*`), the principals allowed or denied `ServiceInvoke`; permission groups that grant a
 * single entity show up there as principals of type `PermissionGroup`. Templates and shapes hold the same for their Things in
 * `instanceRunTimePermissions`, and templates their Things' visibility in `instanceVisibilityPermissions`. A collection's
 * grants come from `CollectionFunctions.GetRunTimePermissionsAsJSON`. Who holds a principal comes from the bodies of
 * roles (`members.User`, `.Group`, `.PermissionGroup`), permission groups (nested `members.PermissionGroup`), user groups
 * (`members: [{name, type}]`) and organisations (`organizationalUnits.<unit>.members`).
 *
 * The rule the issues follow (notes section 1): a service's calls to another entity succeed when System holds the rights,
 * even if the caller holds none, and otherwise only with the caller's own rights.
 */

export const SYSTEM_USER = 'System';

/** A principal named in a permission list. */
export interface Principal { name: string; type: string }

/** One entry of a permission list, and where it was read. */
export interface Grant extends Principal {
  permitted: boolean;
  /** Where the grant was read, for example "Thing CM.Api", "Template CM.Gateway.TT (its Things)" or "Things collection". */
  source: string;
}

/** A permission list to read grants from: the body section and a label for it. */
export interface PermissionSource {
  label: string;
  /** `runTimePermissions` or `instanceRunTimePermissions` (`{ permissions: [...] }`), or null. */
  runTime?: any;
  /** `visibilityPermissions` or `instanceVisibilityPermissions` (`{ Visibility: [...] }`), or null. */
  visibility?: any;
}

/** Grants of `permission` (for example ServiceInvoke) on `resource`, including the `*` resource, from every source. */
export function runTimeGrants(sources: PermissionSource[], permission: string, resource: string): Grant[] {
  const grants: Grant[] = [];
  for (const source of sources) {
    for (const entry of source.runTime?.permissions ?? []) {
      if (entry?.resourceName !== resource && entry?.resourceName !== '*') continue;
      for (const principal of entry[permission] ?? []) {
        if (!principal?.name) continue;
        const label = entry.resourceName === '*' ? `${source.label}, every service` : source.label;
        grants.push({ name: principal.name, type: principal.type ?? 'User', permitted: principal.isPermitted !== false, source: label });
      }
    }
  }
  return grants;
}

/** Visibility grants from every source. */
export function visibilityGrants(sources: PermissionSource[]): Grant[] {
  const grants: Grant[] = [];
  for (const source of sources) {
    for (const principal of source.visibility?.Visibility ?? []) {
      if (!principal?.name) continue;
      grants.push({ name: principal.name, type: principal.type ?? 'Organization', permitted: principal.isPermitted !== false, source: source.label });
    }
  }
  return grants;
}

/** Resource names (services, or `*`) that any source names in `permission`, with at least one principal. */
export function grantedResources(sources: PermissionSource[], permission: string): Set<string> {
  const names = new Set<string>();
  for (const source of sources) {
    for (const entry of source.runTime?.permissions ?? []) {
      if (entry?.resourceName && (entry[permission] ?? []).length) names.add(entry.resourceName);
    }
  }
  return names;
}

/** The bodies of the security entities, as `GET /<collection>/<name>` returns them. */
export interface SecurityBodies {
  roles: any[];
  permissionGroups: any[];
  groups: any[];
  organizations: any[];
}

/** Who holds a principal: whether System does, and the principals other than System that do (as text). */
export interface Holders { system: boolean; others: string[] }

/**
 * Membership of every security entity, to answer "does System hold this principal" and "who else does". Users reach a
 * permission group only through a role that holds it, directly or through a permission group that nests it.
 */
export class SecurityDirectory {
  private readonly groupMembers = new Map<string, Principal[]>();
  private readonly roleMembers = new Map<string, Principal[]>();
  private readonly nestedGroups = new Map<string, string[]>();
  private readonly units = new Map<string, Principal[]>();   // "Org:Unit"
  private readonly organizationUnits = new Map<string, string[]>();
  private readonly systemGroups = new Map<string, boolean>();

  constructor(bodies: SecurityBodies) {
    for (const group of bodies.groups) {
      if (group?.name) this.groupMembers.set(group.name, (group.members ?? []).filter((member: any) => member?.name).map((member: any) => ({ name: member.name, type: member.type ?? 'User' })));
    }
    for (const role of bodies.roles) {
      if (role?.name) this.roleMembers.set(role.name, membersOf(role.members));
    }
    for (const permissionGroup of bodies.permissionGroups) {
      if (permissionGroup?.name) this.nestedGroups.set(permissionGroup.name, Object.keys(permissionGroup.members?.PermissionGroup ?? {}));
    }
    for (const organization of bodies.organizations) {
      if (!organization?.name) continue;
      const unitNames: string[] = [];
      for (const [unitName, unit] of Object.entries<any>(organization.organizationalUnits ?? {})) {
        const key = `${organization.name}:${unit?.name ?? unitName}`;
        unitNames.push(key);
        this.units.set(key, (unit?.members ?? []).filter((member: any) => member?.name).map((member: any) => ({ name: member.name, type: member.type ?? 'User' })));
      }
      this.organizationUnits.set(organization.name, unitNames);
    }
  }

  /** True when the user group holds System, directly or through a nested group. */
  groupHoldsSystem(group: string, seen = new Set<string>()): boolean {
    const known = this.systemGroups.get(group);
    if (known !== undefined) return known;
    if (seen.has(group)) return false;
    seen.add(group);
    const holds = (this.groupMembers.get(group) ?? []).some((member) =>
      (member.type === 'User' && member.name === SYSTEM_USER) || (member.type === 'Group' && this.groupHoldsSystem(member.name, seen)));
    this.systemGroups.set(group, holds);
    return holds;
  }

  /** Roles that hold the permission group, directly or through permission groups that nest it. */
  rolesHolding(permissionGroup: string): string[] {
    const holders = new Set<string>([permissionGroup]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [parent, children] of this.nestedGroups) {
        if (!holders.has(parent) && children.some((child) => holders.has(child))) { holders.add(parent); grew = true; }
      }
    }
    const roles: string[] = [];
    for (const [role, members] of this.roleMembers) {
      if (members.some((member) => member.type === 'PermissionGroup' && holders.has(member.name))) roles.push(role);
    }
    return roles.sort((left, right) => left.localeCompare(right));
  }

  /** Who holds the principal: System or not, and every other user or group that does. */
  holders(principal: Principal): Holders {
    switch (principal.type) {
      case 'User':
        return principal.name === SYSTEM_USER ? { system: true, others: [] } : { system: false, others: [`user ${principal.name}`] };
      case 'Group':
        return this.membersHolders([{ name: principal.name, type: 'Group' }], '');
      case 'Role':
        return this.membersHolders(this.roleMembers.get(principal.name) ?? [], `role ${principal.name}: `);
      case 'PermissionGroup': {
        const result: Holders = { system: false, others: [] };
        for (const role of this.rolesHolding(principal.name)) {
          const holders = this.membersHolders((this.roleMembers.get(role) ?? []).filter((member) => member.type !== 'PermissionGroup'), `role ${role}: `);
          result.system ||= holders.system;
          result.others.push(...holders.others);
        }
        return result;
      }
      case 'Organization': {
        const result: Holders = { system: false, others: [] };
        for (const unit of this.organizationUnits.get(principal.name) ?? []) merge(result, this.membersHolders(this.units.get(unit) ?? [], `unit ${unit}: `));
        return result;
      }
      case 'OrganizationalUnit':
        return this.membersHolders(this.units.get(principal.name) ?? [], `unit ${principal.name}: `);
      default:
        return { system: false, others: [`${principal.type} ${principal.name}`] };
    }
  }

  private membersHolders(members: Principal[], prefix: string): Holders {
    const result: Holders = { system: false, others: [] };
    for (const member of members) {
      if (member.type === 'User') {
        if (member.name === SYSTEM_USER) result.system = true;
        else result.others.push(`${prefix}user ${member.name}`);
      } else if (member.type === 'Group') {
        if (this.groupHoldsSystem(member.name)) result.system = true;
        // A user group is there for users, so it counts even before anyone joins; only a group of System alone does not.
        if (this.groupHasOthers(member.name)) result.others.push(`${prefix}group ${member.name}${this.groupIsEmpty(member.name) ? ' (no members yet)' : ''}`);
      }
    }
    return result;
  }

  /** False only for a group whose members are System alone (directly or through nested groups); an empty or unknown group counts. */
  private groupHasOthers(group: string, seen = new Set<string>()): boolean {
    if (seen.has(group)) return false;
    seen.add(group);
    const members = this.groupMembers.get(group);
    if (!members || !members.length) return true;
    return members.some((member) => (member.type === 'User' && member.name !== SYSTEM_USER) || (member.type === 'Group' && this.groupHasOthers(member.name, seen)));
  }

  private groupIsEmpty(group: string): boolean {
    return (this.groupMembers.get(group) ?? [null]).length === 0;
  }
}

function membersOf(members: any): Principal[] {
  const found: Principal[] = [];
  for (const [type, byName] of Object.entries<any>(members ?? {})) {
    for (const name of Object.keys(byName ?? {})) found.push({ name, type });
  }
  return found;
}

function merge(target: Holders, extra: Holders): void {
  target.system ||= extra.system;
  target.others.push(...extra.others);
}

/** 'yes' / 'no', 'denied' when an explicit deny reaches System, 'unknown' when the security entities could not be read. */
export type SystemAccess = 'yes' | 'no' | 'denied' | 'unknown';

export interface AccessSummary {
  system: SystemAccess;
  /** Principals other than System that are allowed, with who holds each ("CM.PG.Facade (role CM.Role.Operator: group CM.Operators)"). */
  others: string[];
  grants: Grant[];
}

/** Whether System holds the grants, and who else does. Without a directory only a grant to System itself is known. */
export function summariseAccess(grants: Grant[], directory: SecurityDirectory | null): AccessSummary {
  let systemAllowed = false;
  let systemDenied = false;
  const others: string[] = [];
  for (const grant of grants) {
    // Without the directory a user grant is still clear; any other principal counts as someone other than System.
    const holders: Holders = directory ? directory.holders(grant)
      : grant.type === 'User' && grant.name === SYSTEM_USER ? { system: true, others: [] }
      : { system: false, others: [`${grant.type === 'User' ? 'user' : grant.type} ${grant.name}`] };
    if (holders.system) {
      if (grant.permitted) systemAllowed = true;
      else systemDenied = true;
    }
    if (grant.permitted && holders.others.length) {
      const who = !directory || grant.type === 'User' || grant.type === 'Group' ? holders.others.join(', ') : `${grant.type} ${grant.name} (${holders.others.join('; ')})`;
      others.push(who);
    }
  }
  const system: SystemAccess = systemDenied ? 'denied' : systemAllowed ? 'yes' : directory ? 'no' : 'unknown';
  return { system, others: [...new Set(others)], grants };
}

/** The issues the explorer flags on a service. */
export type PermissionIssue = 'system-missing' | 'users-not-ui';

export const ISSUE_TEXT: Record<PermissionIssue, string> = {
  'system-missing': 'Called by another service, but System lacks access: the call only works with the caller\'s own permissions, which a lower-level service should not need to grant.',
  'users-not-ui': 'Users are granted access, but no mashup, widget or Angular code calls it: the grant should not be needed.',
};

export interface ServiceCheckInput {
  invoke: AccessSummary;
  visibility: AccessSummary;
  calledByServices: number;
  calledFromUi: number;
}

/**
 * The issues of one service.
 * - `system-missing`: another service calls it, and System holds no visibility or no ServiceInvoke (a deny counts as none).
 *   Unknown System access raises nothing.
 * - `users-not-ui`: a principal other than System may invoke it, and nothing in a mashup, widget or Angular bundle calls it.
 */
export function serviceIssues(input: ServiceCheckInput): PermissionIssue[] {
  const issues: PermissionIssue[] = [];
  const lacks = (access: SystemAccess): boolean => access === 'no' || access === 'denied';
  if (input.calledByServices > 0 && (lacks(input.invoke.system) || lacks(input.visibility.system))) issues.push('system-missing');
  if (input.invoke.others.length > 0 && input.calledFromUi === 0) issues.push('users-not-ui');
  return issues;
}
