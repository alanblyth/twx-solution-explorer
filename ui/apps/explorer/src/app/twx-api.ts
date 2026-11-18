import { collectionOfType } from './models.ts';
import type { EntityRow, PackageInfo } from './models.ts';
import { parseDependsOn } from './extension-graph.ts';
import type { MemberEntity } from './extension-graph.ts';

/** The user may not see or use the entity (HTTP 403 or 404). Common on a platform with organisational-unit visibility. */
export class NotVisibleError extends Error {}

export interface ApiOptions { baseUrl: string; appKey?: string }

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
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${path}`);
    const text = await response.text();
    return text.trim() ? JSON.parse(text) : null;
  }

  private encode(name: string): string {
    return encodeURIComponent(name);
  }

  /** Entity JSON: `GET /<collection>/<name>`. Null when it is missing or not visible. */
  async entity(collection: string, name: string): Promise<any | null> {
    try {
      return await this.request('GET', `${collection}/${this.encode(name)}`);
    } catch (error) {
      if (error instanceof NotVisibleError) return null;
      throw error;
    }
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
    const details = await mapWithLimit(names, 6, async (name) => this.entity('ExtensionPackages', name));
    return names.map((name, index) => {
      const body = details[index] ?? {};
      return { name, version: body.packageVersion ?? '', vendor: body.vendor ?? '', description: body.description ?? '', dependsOn: parseDependsOn(body.dependsOn) };
    });
  }

  async packageEntities(packageName: string): Promise<MemberEntity[]> {
    const result = await this.request('POST', 'Subsystems/PlatformSubsystem/Services/GetExtensionPackageDetails', { packageName });
    return (result?.rows ?? []).map((row: any) => ({ name: row.name, type: row.type }));
  }

  /** Entities this entity uses (`direction` out) or that use it (`in`). Null when the entity is not visible to the user. */
  async dependencies(direction: 'out' | 'in', type: string, name: string): Promise<MemberEntity[] | null> {
    const service = direction === 'out' ? 'GetOutgoingDependencies' : 'GetIncomingDependencies';
    try {
      const result = await this.request('POST', `${collectionOfType(type)}/${this.encode(name)}/Services/${service}`, {});
      return (result?.rows ?? []).map((row: any) => ({ name: row.name, type: row.type }));
    } catch (error) {
      if (error instanceof NotVisibleError) return null;
      throw error;
    }
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
