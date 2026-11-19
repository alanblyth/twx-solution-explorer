import type { SecurityBodies } from './permissions.ts';

/**
 * The membership graph of a platform's security entities, from their bodies (ThingWorx 10.2.1, read on twx-dev): an
 * organisation's `organizationalUnits.<unit>.members` and its `connections` ([{from, to}], `from` "" for the top unit, else
 * the parent unit), a user group's `members` ([{name, type}]), a role's `members` ({User|Group|PermissionGroup: {name: {}}})
 * and a permission group's nested `members.PermissionGroup` and `entityPermissions`. No Angular here.
 *
 * Every link points from the container to what it holds: organisation → top unit → child unit → member user or group;
 * group → user or group; role → user, group or permission group; permission group → nested permission group.
 */

export type SecurityKind = 'Organization' | 'OrganizationalUnit' | 'Group' | 'User' | 'Role' | 'PermissionGroup';

export const KIND_LABEL: Record<SecurityKind, string> = {
  Organization: 'Organisation', OrganizationalUnit: 'Org unit', Group: 'User group', User: 'User', Role: 'Role', PermissionGroup: 'Permission group',
};

export interface SecurityRef { kind: SecurityKind; name: string }

export type Relation = 'unit' | 'sub-unit' | 'member' | 'includes';
export interface SecurityLink { from: SecurityRef; to: SecurityRef; relation: Relation }

/** One permission a permission group grants. */
export interface EntityPermissionRow {
  entityType: string;
  entityName: string;
  /** 'entity' for the entity itself, 'instances' for a template's or shape's Things. */
  scope: 'entity' | 'instances';
  category: string;
  permission: string;
  /** A service, property or event name, '*' for all, '' when the permission has none (Visibility, Create). */
  resource: string;
  permitted: boolean;
}

export function refKey(ref: SecurityRef): string {
  return `${ref.kind}:${ref.name}`;
}

export function parseRefKey(key: string): SecurityRef {
  const separator = key.indexOf(':');
  return { kind: key.slice(0, separator) as SecurityKind, name: key.slice(separator + 1) };
}

const MEMBER_KINDS = new Set<string>(['User', 'Group', 'PermissionGroup']);

export class SecurityModel {
  readonly links: SecurityLink[] = [];
  private readonly names = new Map<SecurityKind, Set<string>>();
  private readonly down = new Map<string, SecurityLink[]>();
  private readonly up = new Map<string, SecurityLink[]>();
  private readonly permissions = new Map<string, EntityPermissionRow[]>();
  private readonly descriptions = new Map<string, string>();

  constructor(bodies: SecurityBodies, userNames: string[] = []) {
    for (const user of userNames) this.know({ kind: 'User', name: user });
    for (const organization of bodies.organizations) {
      if (!organization?.name) continue;
      const orgRef: SecurityRef = { kind: 'Organization', name: organization.name };
      this.know(orgRef, organization.description);
      const units: Record<string, any> = organization.organizationalUnits ?? {};
      const unitRef = (unit: string): SecurityRef => ({ kind: 'OrganizationalUnit', name: `${organization.name}:${unit}` });
      const placed = new Set<string>();
      for (const connection of organization.connections ?? []) {
        if (!connection?.to) continue;
        placed.add(connection.to);
        if (connection.from) this.link(unitRef(connection.from), unitRef(connection.to), 'sub-unit');
        else this.link(orgRef, unitRef(connection.to), 'unit');
      }
      for (const [key, unit] of Object.entries<any>(units)) {
        const unitName = unit?.name ?? key;
        this.know(unitRef(unitName), unit?.description);
        if (!placed.has(unitName)) this.link(orgRef, unitRef(unitName), 'unit');
        for (const member of unit?.members ?? []) {
          if (member?.name && MEMBER_KINDS.has(member.type ?? 'User')) this.link(unitRef(unitName), { kind: member.type ?? 'User', name: member.name }, 'member');
        }
      }
    }
    for (const group of bodies.groups) {
      if (!group?.name) continue;
      const groupRef: SecurityRef = { kind: 'Group', name: group.name };
      this.know(groupRef, group.description);
      for (const member of group.members ?? []) {
        if (member?.name && MEMBER_KINDS.has(member.type ?? 'User')) this.link(groupRef, { kind: member.type ?? 'User', name: member.name }, 'member');
      }
    }
    for (const role of bodies.roles) {
      if (!role?.name) continue;
      const roleRef: SecurityRef = { kind: 'Role', name: role.name };
      this.know(roleRef, role.description);
      for (const [type, byName] of Object.entries<any>(role.members ?? {})) {
        if (!MEMBER_KINDS.has(type)) continue;
        for (const name of Object.keys(byName ?? {})) this.link(roleRef, { kind: type as SecurityKind, name }, 'member');
      }
    }
    for (const permissionGroup of bodies.permissionGroups) {
      if (!permissionGroup?.name) continue;
      const groupRef: SecurityRef = { kind: 'PermissionGroup', name: permissionGroup.name };
      this.know(groupRef, permissionGroup.description);
      for (const name of Object.keys(permissionGroup.members?.PermissionGroup ?? {})) this.link(groupRef, { kind: 'PermissionGroup', name }, 'includes');
      this.permissions.set(refKey(groupRef), entityPermissionRows(permissionGroup.entityPermissions));
    }
  }

  private know(ref: SecurityRef, description?: string): void {
    const names = this.names.get(ref.kind) ?? new Set<string>();
    names.add(ref.name);
    this.names.set(ref.kind, names);
    if (description) this.descriptions.set(refKey(ref), description);
  }

  private link(from: SecurityRef, to: SecurityRef, relation: Relation): void {
    this.know(from);
    this.know(to);
    const link = { from, to, relation };
    this.links.push(link);
    this.down.set(refKey(from), [...(this.down.get(refKey(from)) ?? []), link]);
    this.up.set(refKey(to), [...(this.up.get(refKey(to)) ?? []), link]);
  }

  /** Every name of a kind, in alphabetical order. */
  namesOf(kind: SecurityKind): string[] {
    return [...(this.names.get(kind) ?? [])].sort((left, right) => left.localeCompare(right));
  }

  has(ref: SecurityRef): boolean {
    return this.names.get(ref.kind)?.has(ref.name) ?? false;
  }

  description(ref: SecurityRef): string {
    return this.descriptions.get(refKey(ref)) ?? '';
  }

  /** What directly holds it (`up`) or what it directly holds (`down`). */
  direct(ref: SecurityRef, direction: 'up' | 'down'): SecurityLink[] {
    return (direction === 'up' ? this.up : this.down).get(refKey(ref)) ?? [];
  }

  /** Everything that holds it (`up`) or that it holds (`down`), however indirectly; itself left out. */
  transitive(ref: SecurityRef, direction: 'up' | 'down'): SecurityRef[] {
    const seen = new Map<string, SecurityRef>();
    const queue = [ref];
    while (queue.length) {
      const current = queue.shift() as SecurityRef;
      for (const link of this.direct(current, direction)) {
        const next = direction === 'up' ? link.from : link.to;
        const key = refKey(next);
        if (key === refKey(ref) || seen.has(key)) continue;
        seen.set(key, next);
        queue.push(next);
      }
    }
    return [...seen.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
  }

  /**
   * What reaches a user or group through roles: the permission groups of every role that holds it, with the groups those
   * nest. For a permission group: the users and groups that reach it through roles.
   */
  throughRoles(ref: SecurityRef): SecurityRef[] {
    const found = new Map<string, SecurityRef>();
    const roles = this.transitive(ref, 'up').filter((holder) => holder.kind === 'Role');
    for (const role of roles) {
      for (const held of this.transitive(role, 'down')) {
        const wanted = ref.kind === 'PermissionGroup' ? held.kind === 'User' || held.kind === 'Group' : held.kind === 'PermissionGroup';
        if (wanted) found.set(refKey(held), held);
      }
    }
    return [...found.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
  }

  /** What a permission group grants, directly (not through nested groups). */
  entityPermissions(ref: SecurityRef): EntityPermissionRow[] {
    return this.permissions.get(refKey(ref)) ?? [];
  }

  /**
   * The links around one entity: everything that holds it, up to `upDepth` steps, and everything it holds, down to
   * `downDepth`, at most `limit` links. `truncated` says some were left out.
   */
  neighbourhood(ref: SecurityRef, upDepth: number, downDepth: number, limit = 250): { links: SecurityLink[]; truncated: boolean } {
    const links = new Map<string, SecurityLink>();
    let truncated = false;
    const walk = (direction: 'up' | 'down', depth: number): void => {
      let frontier = [ref];
      const visited = new Set<string>([refKey(ref)]);
      for (let level = 0; level < depth && frontier.length; level++) {
        const next: SecurityRef[] = [];
        for (const current of frontier) {
          for (const link of this.direct(current, direction)) {
            if (links.size >= limit) { truncated = true; return; }
            links.set(`${refKey(link.from)}>${refKey(link.to)}`, link);
            const other = direction === 'up' ? link.from : link.to;
            if (!visited.has(refKey(other))) { visited.add(refKey(other)); next.push(other); }
          }
        }
        frontier = next;
      }
    };
    walk('up', upDepth);
    walk('down', downDepth);
    return { links: [...links.values()], truncated };
  }

  /** Every role with what it directly holds, and every organisation with its unit tree: the overview, at most `limit` links. */
  overview(limit = 400): { links: SecurityLink[]; truncated: boolean } {
    const chosen = this.links.filter((link) => link.from.kind === 'Role' || link.relation === 'unit' || link.relation === 'sub-unit' || link.relation === 'includes');
    return { links: chosen.slice(0, limit), truncated: chosen.length > limit };
  }
}

/** The rows of a permission group's `entityPermissions`: {type: {name: {onEntity|onInstances: {category: {permission: ...}}}}}. */
export function entityPermissionRows(entityPermissions: any): EntityPermissionRow[] {
  const rows: EntityPermissionRow[] = [];
  for (const [entityType, byName] of Object.entries<any>(entityPermissions ?? {})) {
    for (const [entityName, byScope] of Object.entries<any>(byName ?? {})) {
      for (const [scopeKey, byCategory] of Object.entries<any>(byScope ?? {})) {
        const scope = scopeKey === 'onInstances' ? 'instances' : 'entity';
        for (const [category, byPermission] of Object.entries<any>(byCategory ?? {})) {
          for (const [permission, value] of Object.entries<any>(byPermission ?? {})) {
            if (value && typeof value === 'object' && 'isPermitted' in value) {
              rows.push({ entityType, entityName, scope, category, permission, resource: '', permitted: value.isPermitted !== false });
              continue;
            }
            for (const [resource, setting] of Object.entries<any>(value ?? {})) {
              rows.push({ entityType, entityName, scope, category, permission, resource, permitted: setting?.isPermitted !== false });
            }
          }
        }
      }
    }
  }
  return rows.sort((left, right) => left.entityType.localeCompare(right.entityType) || left.entityName.localeCompare(right.entityName)
    || left.category.localeCompare(right.category) || left.permission.localeCompare(right.permission) || left.resource.localeCompare(right.resource));
}
