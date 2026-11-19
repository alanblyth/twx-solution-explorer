import type { MemberEntity } from './extension-graph.ts';

/** How many users of an entity are shown at once, in the "Used by" list and in its search. */
export const USED_BY_LIMIT = 10;

/** GetIncomingDependencies returns at most this many rows (its maxItems default); a list this long may be cut. */
export const DEPENDENCY_ROW_CAP = 500;

/** Collections whose users can be searched on the platform with QueryImplementingThings (past the 500-row cap). */
export const IMPLEMENTER_COLLECTIONS = new Set(['ThingTemplates', 'ThingShapes']);

export interface UsedByGroup { type: string; items: MemberEntity[] }

/** Entities grouped by type (types and names in alphabetical order). */
export function groupByType(items: MemberEntity[]): UsedByGroup[] {
  const byType = new Map<string, MemberEntity[]>();
  for (const item of items) byType.set(item.type, [...(byType.get(item.type) ?? []), item]);
  return [...byType.entries()]
    .map(([type, list]) => ({ type, items: list.sort((left, right) => left.name.localeCompare(right.name)) }))
    .sort((left, right) => left.type.localeCompare(right.type));
}

/** The first `limit` entities of the groups, in group order; groups left empty are dropped. */
export function firstOfGroups(groups: UsedByGroup[], limit: number): UsedByGroup[] {
  const shown: UsedByGroup[] = [];
  let left = limit;
  for (const group of groups) {
    if (left <= 0) break;
    shown.push({ type: group.type, items: group.items.slice(0, left) });
    left -= Math.min(left, group.items.length);
  }
  return shown;
}

/** The count to show next to "Used by": "500+" when the list reached the platform's row cap. */
export function usedByCount(count: number): string {
  return count >= DEPENDENCY_ROW_CAP ? `${DEPENDENCY_ROW_CAP}+` : String(count);
}

/** A QueryImplementingThings name mask for a substring search; undefined for an empty search. `*` in the text is dropped. */
export function substringMask(text: string): string | undefined {
  const cleaned = text.replace(/\*/g, '').trim();
  return cleaned ? `*${cleaned}*` : undefined;
}

/** Users whose name contains `text` (any case), at most `limit`, and whether there were more. */
export function filterUsers(items: MemberEntity[], text: string, limit: number): { items: MemberEntity[]; more: boolean } {
  const needle = text.trim().toLowerCase();
  const matches = needle ? items.filter((item) => item.name.toLowerCase().includes(needle)) : items;
  const sorted = [...matches].sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
  return { items: sorted.slice(0, limit), more: sorted.length > limit };
}
