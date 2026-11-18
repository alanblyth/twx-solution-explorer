import { ChangeDetectionStrategy, Component, ViewEncapsulation, computed, effect, input, output, signal, untracked } from '@angular/core';
import { SHARED_STYLES } from './styles.ts';
import { GraphViewComponent } from './graph-view.component.ts';
import { SequenceViewComponent } from './sequence-view.component.ts';
import { EMPTY_GRAPH, layoutGraph } from './graph-layout.ts';
import type { GraphEdge, GraphNode, PlacedNode } from './graph-layout.ts';
import { CallResolver, countNodes, forEachCallee } from './call-resolver.ts';
import { collectionOfType, entityKey, entityLabel, singular } from './models.ts';
import type { CallTree, EntityRow, ServiceSummary } from './models.ts';
import type { MemberEntity } from './extension-graph.ts';
import type { TwxApi } from './twx-api.ts';

const COLLECTIONS = ['Things', 'ThingTemplates', 'ThingShapes', 'DataShapes', 'Mashups', 'Projects'];
const SERVICE_COLLECTIONS = new Set(['Things', 'ThingTemplates', 'ThingShapes']);
const NODE_LIMIT = 60;

const KIND_TEXT: Record<string, string> = {
  script: 'JavaScript service', java: 'Java service (not analysed)', sql: 'SQL service (not analysed)', builtin: 'Built-in platform service',
  platform: 'Platform resource or subsystem service', missing: 'Entity or service not found, or not visible to you', dynamic: 'Target chosen at run time',
  recursive: 'Already on the call path (recursion)', limit: 'Depth limit reached; raise the depth to follow it',
};

@Component({
  selector: 'se-entities-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.ShadowDom,
  imports: [GraphViewComponent, SequenceViewComponent],
  template: `
    <div class="layout">
      <aside class="picker">
        <div class="toolbar">
          <select (change)="collection.set($any($event.target).value)">
            @for (item of collections; track item) { <option [value]="item" [selected]="item === collection()">{{ item }}</option> }
          </select>
          <input type="search" placeholder="Filter by name" [value]="query()" (input)="query.set($any($event.target).value)"/>
        </div>
        <div class="results">
          @for (row of results(); track row.name) {
            <div class="row" [class.on]="row.name === selected()?.name && row.collection === selected()?.collection" (click)="choose(row)" [title]="row.description">
              <span class="name">{{ row.name }}</span>
              <span class="muted desc">{{ row.description }}</span>
            </div>
          } @empty {
            <p class="muted">{{ searching() ? 'Searching…' : 'No matches.' }}</p>
          }
        </div>
      </aside>

      <section class="detail">
        @if (selected(); as entity) {
          <div class="toolbar title">
            <h2>{{ entity.name }}</h2><span class="pill">{{ singularName(entity.collection) }}</span>
            <span class="spacer"></span>
            <button [class.primary]="subTab() === 'dependencies'" (click)="subTab.set('dependencies')">Dependencies</button>
            <button [class.primary]="subTab() === 'services'" (click)="subTab.set('services')" [disabled]="!hasServices()">Services</button>
          </div>
          @if (notVisible()) { <p class="warn">This entity could not be read: it does not exist or is not visible to you.</p> }

          @if (subTab() === 'dependencies') {
            <div class="deps">
              <div class="graph">
                @if (dependencyGraph().nodes.length > 1) {
                  <se-graph-view [graph]="dependencyGraph()" [selectedNode]="'self'" (nodeClicked)="openDependency($event)"/>
                } @else if (!loading()) { <p class="muted">No direct dependencies.</p> }
              </div>
              <div class="lists">
                @if (loading()) { <p class="muted">Loading…</p> }
                <h4>Uses ({{ outgoing().length }})</h4>
                @for (group of groupedOutgoing(); track group.type) {
                  <div class="group"><span class="pill">{{ group.type }}</span> @for (item of group.items; track item.name) { <a (click)="openMember(item)">{{ item.name }}</a> }</div>
                } @empty { <div class="muted">nothing</div> }
                <h4>Used by ({{ incoming().length }})</h4>
                @for (group of groupedIncoming(); track group.type) {
                  <div class="group"><span class="pill">{{ group.type }}</span> @for (item of group.items; track item.name) { <a (click)="openMember(item)">{{ item.name }}</a> }</div>
                } @empty { <div class="muted">nothing</div> }
              </div>
            </div>
          } @else {
            <div class="services">
              <div class="svc-list">
                <input type="search" placeholder="Filter services" [value]="serviceFilter()" (input)="serviceFilter.set($any($event.target).value)"/>
                <div class="svc-scroll">
                  @for (service of filteredServices(); track service.name) {
                    <div class="row" [class.on]="service.name === selectedService()" [class.dim]="service.origin === 'builtin'" (click)="analyse(service.name)" [title]="service.description">
                      <span class="name">{{ service.name }}</span>
                      <span class="pill" [class.own]="service.origin === 'own'">{{ service.origin === 'inherited' ? service.sourceName : service.origin }}</span>
                    </div>
                  } @empty { <p class="muted">{{ loading() ? 'Loading…' : 'No services.' }}</p> }
                </div>
                <label class="muted"><input type="checkbox" [checked]="showBuiltin()" (change)="showBuiltin.set(!showBuiltin())"/> show built-in services</label>
              </div>
              <div class="trace">
                @if (selectedService(); as service) {
                  <div class="toolbar">
                    <b>{{ entity.name }}.{{ service }}()</b>
                    <span class="spacer"></span>
                    <label>Depth <select (change)="setDepth($any($event.target).value)">@for (n of [1,2,3,4,5,6,8,10]; track n) { <option [value]="n" [selected]="n === depth()">{{ n }}</option> }</select></label>
                    <button (click)="refresh()" title="Read the scripts again">Reload</button>
                    <button [class.primary]="view() === 'graph'" (click)="view.set('graph')">Call graph</button>
                    <button [class.primary]="view() === 'sequence'" (click)="view.set('sequence')">Sequence diagram</button>
                  </div>
                  @if (analysing()) { <p class="muted">Reading scripts… {{ progress() }} services</p> }
                  @else if (tree(); as root) {
                    <p class="muted summary">{{ summary(root) }}</p>
                    <div class="view">
                      @if (view() === 'graph') {
                        <se-graph-view [graph]="callGraph()" [selectedNode]="selectedNode()" (nodeClicked)="selectedNode.set($event.id)"/>
                      } @else {
                        <se-sequence-view [tree]="root"/>
                      }
                    </div>
                    @if (selectedNodeInfo(); as info) { <p class="node-info"><b>{{ info.title }}</b> — {{ info.text }}</p> }
                  }
                } @else {
                  <p class="muted pad">Pick a service to see every service it can call, and a sequence diagram of the calls in the order its script makes them.</p>
                }
              </div>
            </div>
          }
        } @else {
          <p class="muted pad">Choose a Thing, template or shape on the left.</p>
        }
      </section>
    </div>
  `,
  styles: [SHARED_STYLES, `
    :host { display: block; height: 100%; min-height: 0; }
    .layout { display: flex; gap: 12px; height: 100%; min-height: 0; padding-top: 8px; }
    .picker { width: 270px; display: flex; flex-direction: column; min-height: 0; gap: 6px; }
    .picker .toolbar select { max-width: 110px; } .picker .toolbar input { flex: 1; min-width: 0; }
    .results, .svc-scroll { flex: 1; overflow: auto; border: 1px solid #d5dce3; border-radius: 4px; background: #fff; min-height: 0; }
    .row { display: flex; gap: 6px; align-items: baseline; padding: 4px 8px; cursor: pointer; border-bottom: 1px solid #f0f3f6; }
    .row:hover { background: #f3f7fb; } .row.on { background: #d6e8fb; } .row.dim { color: #8794a1; }
    .row .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .row .desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; font-size: 11.5px; }
    .detail { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
    .title h2 { margin: 0; font-size: 16px; }
    .deps { flex: 1; display: flex; gap: 12px; min-height: 0; margin-top: 8px; }
    .graph { flex: 1; min-width: 0; } .lists { width: 280px; overflow: auto; }
    .lists h4 { margin: 8px 0 4px; } .group { margin-bottom: 6px; line-height: 1.8; } .group a { margin-left: 8px; }
    a { color: #1565c0; cursor: pointer; text-decoration: underline; }
    .services { flex: 1; display: flex; gap: 12px; min-height: 0; margin-top: 8px; }
    .svc-list { width: 250px; display: flex; flex-direction: column; gap: 6px; min-height: 0; }
    .trace { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; gap: 6px; }
    .view { flex: 1; min-height: 0; } .summary { margin: 0; }
    .pill.own { background: #d6e8fb; color: #0f4f9a; }
    .node-info { margin: 0; padding: 6px 8px; background: #f3f7fb; border-radius: 4px; }
    .pad { padding: 12px 0; }
  `],
})
export class EntitiesTabComponent {
  readonly api = input.required<TwxApi>();
  /** Entity chosen from outside (the widget's bound properties). */
  readonly requestedEntity = input<string>('');
  readonly requestedCollection = input<string>('Things');
  /** Service to open on the requested entity, and how to show it. */
  readonly requestedService = input<string>('');
  readonly requestedView = input<'graph' | 'sequence'>('graph');
  readonly entitySelected = output<string>();
  readonly serviceSelected = output<string>();

  protected readonly collections = COLLECTIONS;
  protected readonly collection = signal('Things');
  protected readonly query = signal('');
  protected readonly results = signal<EntityRow[]>([]);
  protected readonly searching = signal(false);
  protected readonly selected = signal<EntityRow | null>(null);
  protected readonly subTab = signal<'dependencies' | 'services'>('dependencies');
  protected readonly loading = signal(false);
  protected readonly notVisible = signal(false);
  protected readonly outgoing = signal<MemberEntity[]>([]);
  protected readonly incoming = signal<MemberEntity[]>([]);
  protected readonly services = signal<ServiceSummary[]>([]);
  protected readonly serviceFilter = signal('');
  protected readonly showBuiltin = signal(false);
  protected readonly selectedService = signal<string | null>(null);
  protected readonly depth = signal(4);
  protected readonly view = signal<'graph' | 'sequence'>('graph');
  protected readonly analysing = signal(false);
  protected readonly progress = signal(0);
  protected readonly tree = signal<CallTree | null>(null);
  protected readonly selectedNode = signal<string | null>(null);

  private resolver: CallResolver | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private searchCounter = 0;
  private analysisCounter = 0;

  protected readonly hasServices = computed(() => SERVICE_COLLECTIONS.has(this.selected()?.collection ?? ''));
  protected readonly filteredServices = computed(() => {
    const filter = this.serviceFilter().toLowerCase();
    return this.services().filter((item) => (this.showBuiltin() || item.origin !== 'builtin') && item.name.toLowerCase().includes(filter));
  });
  protected readonly groupedOutgoing = computed(() => group(this.outgoing()));
  protected readonly groupedIncoming = computed(() => group(this.incoming()));

  protected readonly dependencyGraph = computed(() => {
    const entity = this.selected();
    if (!entity) return EMPTY_GRAPH;
    const nodes: GraphNode[] = [{ id: 'self', label: entity.name, sublabel: singular(entity.collection), kind: 'root' }];
    const edges: GraphEdge[] = [];
    this.outgoing().slice(0, NODE_LIMIT).forEach((item) => { nodes.push({ id: `out:${item.type}:${item.name}`, label: item.name, sublabel: item.type, kind: 'outgoing' }); edges.push({ from: 'self', to: `out:${item.type}:${item.name}` }); });
    this.incoming().slice(0, NODE_LIMIT).forEach((item) => { nodes.push({ id: `in:${item.type}:${item.name}`, label: item.name, sublabel: item.type, kind: 'incoming' }); edges.push({ from: `in:${item.type}:${item.name}`, to: 'self' }); });
    return layoutGraph(nodes, edges, 'LR');
  });

  protected readonly callGraph = computed(() => {
    const root = this.tree();
    if (!root) return EMPTY_GRAPH;
    const nodes = new Map<string, GraphNode>();
    const counts = new Map<string, number>();
    const idOf = (node: CallTree): string => `${entityKey(node.entity)}.${node.service}`;
    const add = (node: CallTree, isRoot: boolean): void => {
      const id = idOf(node);
      const existing = nodes.get(id);
      if (!existing || (existing.kind === 'recursive' && node.kind !== 'recursive')) {
        nodes.set(id, { id, label: `${node.service}()`, sublabel: entityLabel(node.entity), kind: isRoot ? 'root' : node.kind });
      }
    };
    const visit = (node: CallTree, isRoot: boolean): void => {
      add(node, isRoot);
      forEachCallee(node.steps, (callee) => {
        const key = `${idOf(node)}\u0000${idOf(callee)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (counts.get(key) === 1) visit(callee, false);
      });
    };
    visit(root, true);
    const edges: GraphEdge[] = [...counts.entries()].map(([key, count]) => {
      const [from, to] = key.split('\u0000');
      return { from, to, label: count > 1 ? `×${count}` : undefined };
    });
    return layoutGraph([...nodes.values()], edges, 'LR');
  });

  protected readonly selectedNodeInfo = computed(() => {
    const id = this.selectedNode();
    const root = this.tree();
    if (!id || !root) return null;
    let found: CallTree | null = null;
    const visit = (node: CallTree): void => {
      if (`${entityKey(node.entity)}.${node.service}` === id && (!found || found.kind === 'recursive')) found = node;
      forEachCallee(node.steps, (callee) => { if (callee !== node) visit(callee); });
    };
    visit(root);
    const node = found as CallTree | null;
    if (!node) return null;
    const where = node.implementedBy?.name && node.implementedBy.name !== node.entity.name ? ` Implemented on ${entityLabel(node.implementedBy)}.` : '';
    return { title: `${entityLabel(node.entity)}.${node.service}()`, text: `${KIND_TEXT[node.kind] ?? node.kind}.${where}${node.note ? ' ' + node.note + '.' : ''}` };
  });

  constructor() {
    effect(() => {
      const type = this.collection();
      const text = this.query();
      untracked(() => this.scheduleSearch(type, text));
    });
    effect(() => {
      const name = this.requestedEntity();
      const collection = this.requestedCollection() || 'Things';
      const service = this.requestedService();
      if (name) {
        untracked(async () => {
          this.view.set(this.requestedView());
          await this.choose({ name, collection, type: singular(collection), description: '' });
          if (service) {
            this.subTab.set('services');
            await this.analyse(service);
          }
        });
      }
    });
  }

  protected singularName(collection: string): string { return singular(collection); }

  protected summary(root: CallTree): string {
    const total = countNodes(root);
    return `${total} distinct service${total === 1 ? '' : 's'} reachable to depth ${this.depth()}. Grey boxes are built-in or platform services, purple Java, amber chosen at run time, red not found.`;
  }

  private scheduleSearch(collection: string, text: string): void {
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(async () => {
      const ticket = ++this.searchCounter;
      this.searching.set(true);
      try {
        const rows = await this.api().list(collection);
        const needle = text.trim().toLowerCase();
        const matches = needle ? rows.filter((row) => row.name.toLowerCase().includes(needle) || row.description.toLowerCase().includes(needle)) : rows;
        if (ticket === this.searchCounter) this.results.set(matches.slice(0, 500));
      } catch {
        if (ticket === this.searchCounter) this.results.set([]);
      } finally {
        if (ticket === this.searchCounter) this.searching.set(false);
      }
    }, 150);
  }

  protected async choose(row: EntityRow): Promise<void> {
    this.selected.set(row);
    this.entitySelected.emit(row.name);
    this.selectedService.set(null);
    this.tree.set(null);
    this.services.set([]);
    this.outgoing.set([]);
    this.incoming.set([]);
    this.notVisible.set(false);
    this.loading.set(true);
    if (!this.resolver) this.resolver = this.newResolver();
    const type = singular(row.collection);
    const [outgoing, incoming, services, body] = await Promise.all([
      this.api().dependencies('out', type, row.name),
      this.api().dependencies('in', type, row.name),
      SERVICE_COLLECTIONS.has(row.collection) ? this.resolver.listServices({ collection: row.collection, name: row.name }) : Promise.resolve([]),
      this.api().entity(row.collection, row.name),
    ]);
    if (this.selected() !== row) return;
    this.outgoing.set(outgoing ?? []);
    this.incoming.set(incoming ?? []);
    this.services.set(services);
    this.notVisible.set(body === null);
    this.loading.set(false);
    if (!SERVICE_COLLECTIONS.has(row.collection)) this.subTab.set('dependencies');
  }

  private newResolver(): CallResolver {
    return new CallResolver((collection, name) => this.api().entity(collection, name));
  }

  protected openDependency(node: PlacedNode): void {
    if (node.id === 'self') return;
    const [, type, ...rest] = node.id.split(':');
    this.openMember({ type, name: rest.join(':') });
  }

  protected openMember(member: MemberEntity): void {
    const collection = collectionOfType(member.type);
    this.collection.set(COLLECTIONS.includes(collection) ? collection : this.collection());
    void this.choose({ name: member.name, collection, type: member.type, description: '' });
  }

  protected setDepth(value: string): void {
    this.depth.set(Number(value));
    const service = this.selectedService();
    if (service) void this.analyse(service);
  }

  protected refresh(): void {
    this.resolver = this.newResolver();
    const service = this.selectedService();
    if (service) void this.analyse(service);
  }

  protected async analyse(service: string): Promise<void> {
    const entity = this.selected();
    if (!entity || !this.resolver) return;
    const ticket = ++this.analysisCounter;
    this.selectedService.set(service);
    this.serviceSelected.emit(service);
    this.analysing.set(true);
    this.progress.set(0);
    this.selectedNode.set(null);
    const tree = await this.resolver.resolve({ collection: entity.collection, name: entity.name }, service, {
      maxDepth: this.depth(), onProgress: (count) => { if (ticket === this.analysisCounter) this.progress.set(count); },
    });
    if (ticket !== this.analysisCounter) return;
    this.tree.set(tree);
    this.analysing.set(false);
  }
}

function group(items: MemberEntity[]): { type: string; items: MemberEntity[] }[] {
  const byType = new Map<string, MemberEntity[]>();
  for (const item of items) byType.set(item.type, [...(byType.get(item.type) ?? []), item]);
  return [...byType.entries()].map(([type, list]) => ({ type, items: list.sort((left, right) => left.name.localeCompare(right.name)) })).sort((left, right) => left.type.localeCompare(right.type));
}
