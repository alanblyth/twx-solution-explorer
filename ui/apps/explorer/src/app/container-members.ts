import { memberKey } from './extension-graph.ts';
import type { MemberEntity } from './extension-graph.ts';
import { collectionOfType } from './models.ts';

export type ContainerKind = 'Project' | 'Extension';

/** The calls this module needs from TwxApi, so tests can pass a fake. */
export interface ContainerSource {
  list(collection: string): Promise<{ name: string }[]>;
  packages(): Promise<{ name: string }[]>;
  projectEntities(projectName: string): Promise<MemberEntity[]>;
  packageEntities(packageName: string): Promise<MemberEntity[]>;
}

/**
 * Projects and extensions and the entities they hold, read once per source and kept. Shared by the Projects & Extensions tab
 * (members, owner of an outside entity) and the entity picker (filter by project or extension).
 */
export class ContainerMembers {
  private readonly source: ContainerSource;
  private readonly memberLists = new Map<string, Promise<MemberEntity[]>>();
  private readonly nameLists = new Map<ContainerKind, Promise<string[]>>();

  constructor(source: ContainerSource) {
    this.source = source;
  }

  /** Names of every project or every extension, sorted. */
  names(kind: ContainerKind): Promise<string[]> {
    let names = this.nameLists.get(kind);
    if (!names) {
      const rows = kind === 'Project' ? this.source.list('Projects') : this.source.packages();
      names = rows.then((items) => items.map((item) => item.name).sort((left, right) => left.localeCompare(right)));
      names.catch(() => this.nameLists.delete(kind));
      this.nameLists.set(kind, names);
    }
    return names;
  }

  /** The entities of one project or extension, without its own Project or ExtensionPackage entity. `fresh` reads it again. */
  members(kind: ContainerKind, name: string, fresh = false): Promise<MemberEntity[]> {
    const key = `${kind}:${name}`;
    let members = fresh ? undefined : this.memberLists.get(key);
    if (!members) {
      const ownType = kind === 'Project' ? 'Project' : 'ExtensionPackage';
      const listed = kind === 'Project' ? this.source.projectEntities(name) : this.source.packageEntities(name);
      members = listed.then((entities) => dedupeEntities(entities.filter((entity) => !(entity.type === ownType && entity.name === name))));
      members.catch(() => this.memberLists.delete(key));
      this.memberLists.set(key, members);
    }
    return members;
  }

  /**
   * Which other project or extension holds each entity (key `type:name`). Containers that cannot be read are left out.
   * `onProgress` gets the number read so far and the total; `shouldStop` ends the reading early.
   */
  async ownerMap(kind: ContainerKind, except: string, options: OwnerMapOptions = {}): Promise<Map<string, string>> {
    const others = (await this.names(kind)).filter((other) => other !== except);
    const lists = new Array<MemberEntity[]>(others.length);
    let next = 0;
    let done = 0;
    options.onProgress?.(0, others.length);
    const worker = async (): Promise<void> => {
      while (next < others.length && !options.shouldStop?.()) {
        const index = next++;
        lists[index] = await this.members(kind, others[index], options.fresh).catch(() => []);
        options.onProgress?.(++done, others.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, others.length) }, worker));
    const owners = new Map<string, string>();
    others.forEach((other, index) => {
      for (const entity of lists[index] ?? []) if (!owners.has(memberKey(entity))) owners.set(memberKey(entity), other);
    });
    return owners;
  }
}

export interface OwnerMapOptions {
  fresh?: boolean;
  onProgress?: (done: number, total: number) => void;
  shouldStop?: () => boolean;
}

/** Names of the members that live in a REST collection ("Things" keeps the members of type Thing). */
export function memberNamesIn(members: MemberEntity[], collection: string): Set<string> {
  return new Set(members.filter((member) => collectionOfType(member.type) === collection).map((member) => member.name));
}

export function dedupeEntities(entities: MemberEntity[]): MemberEntity[] {
  const unique = new Map<string, MemberEntity>();
  for (const entity of entities) unique.set(memberKey(entity), entity);
  return [...unique.values()];
}

const sharedInstances = new WeakMap<ContainerSource, ContainerMembers>();

/** One ContainerMembers per API client, so every tab shares what has been read. */
export function containerMembersFor(source: ContainerSource): ContainerMembers {
  let found = sharedInstances.get(source);
  if (!found) {
    found = new ContainerMembers(source);
    sharedInstances.set(source, found);
  }
  return found;
}
