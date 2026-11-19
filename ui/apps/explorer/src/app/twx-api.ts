import { collectionOfType } from './models.ts';
import type { EntityRow, PackageInfo } from './models.ts';
import { parseDependsOn } from './extension-graph.ts';
import type { MemberEntity } from './extension-graph.ts';
import { substringMask } from './used-by.ts';
import { entityKey, mashupContentLinks, mashupsUsing } from './mashup-content.ts';

/** The user may not see or use the entity (HTTP 403 or 404). Common on a platform with organisational-unit visibility. */
export class NotVisibleError extends Error {}

/** A disabled Thing answers its services with 503 "Thing [...] is not enabled". */
export class NotEnabledError extends Error {}

/**
 * The platform answered with an error of its own (a 500, or a 503 that is not a disabled Thing). `status` is the HTTP
 * status and the message is the platform's text, for example a built-in style definition whose GetOutgoingDependencies
 * fails with 'Cannot invoke "com.thingworx.entities.RootEntity.getID()" because "entity" is null'.
 */
export class PlatformError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The platform's message from an error response: plain text, or the text of an HTML error page, at most 300 characters. */
export function platformMessage(status: number, statusText: string, body: string): string {
  const text = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const message = text || statusText || 'no message';
  return `${status}: ${message.length > 300 ? message.slice(0, 297) + '...' : message}`;
}

/** 'failed': the platform could not run the lookup for this entity (see `reason`); other entities are not affected. */
export type LookupStatus = 'ok' | 'not-visible' | 'not-enabled' | 'failed';
export interface DependencyLookup { items: MemberEntity[]; status: LookupStatus; reason?: string }

/** An entity a scan could not read, and why, as the scans list it. */
export interface UnreadableEntity extends MemberEntity { reason: string }

/** Why a lookup gave nothing, in words for the list of entities a scan could not read. */
export function unreadableEntity(member: MemberEntity, lookup: DependencyLookup): UnreadableEntity {
  const reason = lookup.status === 'failed' ? `the platform failed: ${lookup.reason ?? 'no message'}`
    : lookup.status === 'not-enabled' ? 'disabled, and its definition could not be read'
    : 'not visible to you';
  return { name: member.name, type: member.type, reason };
}

export interface ApiOptions { baseUrl: string; appKey?: string }

/**
 * How many entity bodies the shared cache keeps. A body is about 230 kB (almost all of it the template's effective shape),
 * so 300 is roughly 70 MB at most; the least recently used goes first.
 */
export const ENTITY_CACHE_SIZE = 300;

/** Thin client for the ThingWorx REST API, using the signed-in session (or an application key for development). */
export class TwxApi {
  private readonly baseUrl: string;
  private readonly appKey: string | undefined;

  constructor(options: ApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.appKey = options.appKey || undefined;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json', 'X-XSRF-TOKEN': 'TWX-XSRF-TOKEN-VALUE' };
    if (this.appKey) headers['appKey'] = this.appKey;
    return headers;
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${this.baseUrl}/${path}`, {
      method, headers: this.headers(), credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 403 || response.status === 404) throw new NotVisibleError(`${response.status} ${path}`);
    if (response.status === 503) {
      const text = await response.text();
      if (/not enabled/i.test(text)) throw new NotEnabledError(text);
      throw new PlatformError(503, platformMessage(503, response.statusText, text));
    }
    if (!response.ok) throw new PlatformError(response.status, platformMessage(response.status, response.statusText, await response.text()));
    const text = await response.text();
    return text.trim() ? JSON.parse(text) : null;
  }

  private encode(name: string): string {
    return encodeURIComponent(name);
  }

  private readonly bodies = new Map<string, Promise<any | null>>();

  /**
   * Entity JSON: `GET /<collection>/<name>`, null when it is missing or not visible. Shared by every tab through a small
   * least-recently-used cache, so a template read by one view is not read again by the next. `fresh` reads it again (a
   * scan reads what is there now) and replaces a copy that is cached, but does not add one: a scan of thousands of
   * members would otherwise push out every body the user is browsing. A failed read is not kept.
   */
  entity(collection: string, name: string, options: { fresh?: boolean } = {}): Promise<any | null> {
    const key = `${collection}/${name}`;
    const cached = this.bodies.get(key);
    if (cached && !options.fresh) {
      this.bodies.delete(key);
      this.bodies.set(key, cached);   // most recently used last
      return cached;
    }
    const body = this.request('GET', `${collection}/${this.encode(name)}`).catch((error) => {
      if (error instanceof NotVisibleError) return null;
      throw error;
    });
    if (options.fresh && !cached) return body;
    body.catch(() => { if (this.bodies.get(key) === body) this.bodies.delete(key); });
    this.bodies.delete(key);
    this.bodies.set(key, body);
    while (this.bodies.size > ENTITY_CACHE_SIZE) this.bodies.delete(this.bodies.keys().next().value as string);
    return body;
  }

  /** Forgets every cached entity body (the user asked to read the platform again). */
  forgetEntities(): void {
    this.bodies.clear();
    this.contentUsage = null;
  }

  /** Names of the widgets that are entities (extension widgets). Empty when the collection cannot be listed. */
  async widgetEntityNames(): Promise<Set<string>> {
    try {
      return new Set((await this.list('Widgets')).map((row) => row.name));
    } catch {
      return new Set();
    }
  }

  private contentUsage: Promise<Map<string, string[]>> | null = null;

  /**
   * Which mashups use each entity, read from every mashup's content once (the platform's dependency services leave it
   * out). The bodies are read fresh and not kept in the entity cache; the map is kept until Reload.
   */
  mashupsUsingEntities(): Promise<Map<string, string[]>> {
    if (!this.contentUsage) {
      const usage = (async () => {
        const [widgets, mashups] = await Promise.all([this.widgetEntityNames(), this.list('Mashups')]);
        const names = mashups.map((row) => row.name);
        const bodies = await mapWithLimit(names, 6, (name) => this.entity('Mashups', name, { fresh: true }).catch(() => null));
        return mashupsUsing(names.map((name, index) => ({ name, body: bodies[index] })), widgets);
      })();
      usage.catch(() => { if (this.contentUsage === usage) this.contentUsage = null; });
      this.contentUsage = usage;
    }
    return this.contentUsage;
  }

  /**
   * Links the dependency services leave out, read from mashup content: for a mashup (`out`), the widgets, data sources
   * and mashups it uses; for any entity (`in`), the mashups that use it. `body` is the mashup's JSON when the caller has
   * read it already. Empty for a non-mashup going out.
   */
  async contentLinks(direction: 'out' | 'in', type: string, name: string, body?: any): Promise<MemberEntity[]> {
    if (direction === 'out' && type === 'Mashup') {
      const mashupBody = body ?? await this.entity('Mashups', name, { fresh: true }).catch(() => null);
      return mashupBody ? mashupContentLinks(mashupBody, await this.widgetEntityNames()) : [];
    }
    if (direction === 'in') {
      return ((await this.mashupsUsingEntities()).get(entityKey(type, name)) ?? []).map((mashup) => ({ name: mashup, type: 'Mashup' }));
    }
    return [];
  }

  private readonly listings = new Map<string, Promise<EntityRow[]>>();

  /**
   * Every entity of a collection (name and description), read once per collection. The REST search expression is not a plain
   * name filter, so the page filters this list itself.
   */
  list(collection: string): Promise<EntityRow[]> {
    let listing = this.listings.get(collection);
    if (!listing) {
      listing = this.request('GET', `${collection}?maxItems=20000`).then((result) => (result?.rows ?? [])
        .map((row: any): EntityRow => ({ name: row.name, description: row.description ?? '', collection, type: collection.replace(/s$/, '') }))
        .sort((left: EntityRow, right: EntityRow) => left.name.localeCompare(right.name)));
      listing.catch(() => this.listings.delete(collection));
      this.listings.set(collection, listing);
    }
    return listing;
  }

  async packages(): Promise<PackageInfo[]> {
    const list = await this.request('GET', 'ExtensionPackages');
    const names: string[] = (list?.rows ?? []).map((row: any) => row.name);
    // Fresh: a rescan after an upgrade must show the new version and dependsOn.
    const details = await mapWithLimit(names, 6, async (name) => this.entity('ExtensionPackages', name, { fresh: true }));
    return names.map((name, index) => {
      const body = details[index] ?? {};
      return { name, version: body.packageVersion ?? '', vendor: body.vendor ?? '', description: body.description ?? '', dependsOn: parseDependsOn(body.dependsOn) };
    });
  }

  async packageEntities(packageName: string): Promise<MemberEntity[]> {
    const result = await this.request('POST', 'Subsystems/PlatformSubsystem/Services/GetExtensionPackageDetails', { packageName });
    return (result?.rows ?? []).map((row: any) => ({ name: row.name, type: row.type }));
  }

  /** Entities this entity uses (`direction` out) or that use it (`in`), with why the lookup failed if it did. */
  async dependencyLookup(direction: 'out' | 'in', type: string, name: string): Promise<DependencyLookup> {
    const service = direction === 'out' ? 'GetOutgoingDependencies' : 'GetIncomingDependencies';
    try {
      const result = await this.request('POST', `${collectionOfType(type)}/${this.encode(name)}/Services/${service}`, {});
      return { items: (result?.rows ?? []).map((row: any) => ({ name: row.name, type: row.type })), status: 'ok' };
    } catch (error) {
      if (error instanceof NotVisibleError) return { items: [], status: 'not-visible' };
      if (error instanceof NotEnabledError) return { items: [], status: 'not-enabled' };
      // One entity's lookup failing on the platform must not stop a scan of hundreds; a network failure still throws.
      if (error instanceof PlatformError) return { items: [], status: 'failed', reason: error.message };
      throw error;
    }
  }

  /** Entities this entity uses (`direction` out) or that use it (`in`). Null when the lookup failed (not visible, a disabled Thing, or a platform error). */
  async dependencies(direction: 'out' | 'in', type: string, name: string): Promise<MemberEntity[] | null> {
    const lookup = await this.dependencyLookup(direction, type, name);
    return lookup.status === 'ok' ? lookup.items : null;
  }

  /**
   * Things that implement a template or shape whose name contains `text` (`QueryImplementingThings`, which, unlike
   * GetIncomingDependencies and GetImplementingThings, honours `maxItems`). Asks for one more than `limit` to tell
   * whether there are more; names in alphabetical order.
   */
  async searchImplementingThings(collection: string, name: string, text: string, limit: number): Promise<{ items: MemberEntity[]; more: boolean }> {
    const parameters: Record<string, unknown> = { maxItems: limit + 1 };
    const mask = substringMask(text);
    if (mask) parameters['nameMask'] = mask;
    const result = await this.request('POST', `${collection}/${this.encode(name)}/Services/QueryImplementingThings`, parameters);
    const names: string[] = (result?.rows ?? []).map((row: any) => row.name).sort((left: string, right: string) => left.localeCompare(right));
    return { items: names.slice(0, limit).map((thing) => ({ name: thing, type: 'Thing' })), more: names.length > limit };
  }

  /** The entities of a project (`Projects/<name>` `GetEntities`). */
  async projectEntities(projectName: string): Promise<MemberEntity[]> {
    const result = await this.request('POST', `Projects/${this.encode(projectName)}/Services/GetEntities`, {});
    return (result?.rows ?? []).map((row: any) => ({ name: row.name, type: row.type }));
  }

  private dataThingNames: Promise<Set<string>> | null = null;

  /** Names of Things that hold data (data tables, streams, value streams), read once, for drawing them as cylinders. */
  dataThings(): Promise<Set<string>> {
    if (!this.dataThingNames) {
      const templates = ['DataTable', 'Stream', 'ValueStream'];
      this.dataThingNames = Promise.all(templates.map((template) =>
        this.request('POST', `ThingTemplates/${template}/Services/GetImplementingThings`, {})
          .then((result) => (result?.rows ?? []).map((row: any) => String(row.name)))
          .catch(() => [] as string[])))
        .then((lists) => new Set(lists.flat()));
    }
    return this.dataThingNames;
  }
}

/** Runs `work` over `items` with at most `limit` in flight, keeping the order of the results. */
export async function mapWithLimit<Item, Result>(
  items: Item[], limit: number, work: (item: Item, index: number) => Promise<Result>, shouldStop: () => boolean = () => false,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && !shouldStop()) {
      const index = next++;
      results[index] = await work(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
