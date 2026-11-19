import { ChangeDetectionStrategy, Component, ViewEncapsulation, computed, effect, input, output, signal, untracked } from '@angular/core';
import { SHARED_STYLES } from './styles.ts';
import { GraphViewComponent } from './graph-view.component.ts';
import { SequenceViewComponent } from './sequence-view.component.ts';
import { CodeViewComponent } from './code-view.component.ts';
import { EntityPickerComponent } from './entity-picker.component.ts';
import { EMPTY_GRAPH, layoutGraph } from './graph-layout.ts';
import type { GraphEdge, GraphNode, PlacedEdge, PlacedNode } from './graph-layout.ts';
import type { Message } from './sequence-layout.ts';
import { perfStart, perfSync } from './perf.ts';
import { CallResolver, countNodes } from './call-resolver.ts';
import { collectionOfType, entityLabel, serviceId, singular } from './models.ts';
import type { CallTree, EntityRow, ServiceSummary } from './models.ts';
import type { MemberEntity } from './extension-graph.ts';
import type { TwxApi } from './twx-api.ts';
import { shapeForType } from './node-shapes.ts';
import { dependenciesFromDefinition, readInheritance } from './inheritance.ts';
import type { InheritanceLevel } from './inheritance.ts';
import {
  buildCallGraph, buildInheritanceGraph, callEdgeKey, DERIVED_LIMIT, DERIVED_THINGS_SHOWN, derivedThingCount, inheritanceNames, layoutInheritance, missingCodeReason,
} from './entity-graphs.ts';

const COLLECTIONS = ['Things', 'ThingTemplates', 'ThingShapes', 'DataShapes', 'Mashups', 'Projects'];
const SERVICE_COLLECTIONS = new Set(['Things', 'ThingTemplates', 'ThingShapes']);
const INHERITANCE_COLLECTIONS = SERVICE_COLLECTIONS;
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
  imports: [GraphViewComponent, SequenceViewComponent, CodeViewComponent, EntityPickerComponent],
  template: `
    <div class="layout">
      <se-entity-picker class="picker" [api]="api()" [selected]="selected()" [(collection)]="collection" (picked)="choose($event)"/>

      <section class="detail">
        @if (selected(); as entity) {
          <div class="toolbar title">
            <h2>{{ entity.name }}</h2><span class="pill">{{ singularName(entity.collection) }}</span>
            <span class="spacer"></span>
            <button [class.primary]="subTab() === 'dependencies'" (click)="subTab.set('dependencies')">Dependencies</button>
            <button [class.primary]="subTab() === 'services'" (click)="subTab.set('services')" [disabled]="!hasServices()">Services</button>
          </div>
          @if (notVisible()) { <p class="warn">This entity could not be read: it does not exist or is not visible to you.</p> }
          @if (disabled()) { <p class="warn">This Thing is disabled: dependencies come from its definition; what uses it is unknown.</p> }
          @if (loadError()) { <p class="warn error">Could not load this entity: {{ loadError() }}</p> }

          @if (subTab() === 'dependencies') {
            <div class="deps">
              <div class="graph">
                <div class="toolbar sub-tabs">
                  @if (hasInheritance()) {
                    <button [class.primary]="dependencyView() === 'inheritance'" (click)="chosenDependencyView.set('inheritance')">Inheritance</button>
                    <button [class.primary]="dependencyView() === 'other'" (click)="chosenDependencyView.set('other')"
                      title="The template chain, shapes and derived entities are in the inheritance graph">Other dependencies</button>
                  } @else {
                    <b>Dependencies</b>
                  }
                  @if (dependencyView() === 'inheritance' && derivedThings() > thingsShownLimit) {
                    <span class="spacer"></span>
                    <label class="muted"><input type="checkbox" [checked]="showDerivedThings()" (change)="showDerivedThings.set(!showDerivedThings())"/> Show {{ derivedThings() }} Things</label>
                    @if (showDerivedThings() && derivedThings() > derivedLimit) { <span class="muted">(first {{ derivedLimit }} drawn, all in the Used by list)</span> }
                  }
                </div>
                @if (dependencyView() === 'inheritance') {
                  @if (inheritanceGraph().nodes.length) {
                    <se-graph-view [graph]="inheritanceGraph()" [selectedNode]="inheritanceSelf()" (nodeClicked)="openInheritance($event)"/>
                  } @else if (!loading()) { <p class="muted">No inheritance to show.</p> }
                } @else {
                  @if (dependencyGraph().nodes.length > 1) {
                    <se-graph-view [graph]="dependencyGraph()" [selectedNode]="'self'" (nodeClicked)="openDependency($event)"/>
                  } @else if (!loading()) { <p class="muted">No {{ hasInheritance() ? 'other ' : '' }}direct dependencies.</p> }
                }
              </div>
              <div class="lists">
                @if (loading()) { <p class="muted">Loading…</p> }
                <h4>Uses ({{ outgoing().length }})</h4>
                @for (group of groupedOutgoing(); track group.type) {
                  <div class="group"><span class="pill">{{ group.type }}</span> @for (item of group.items; track item.name) { <a (click)="openMember(item)">{{ item.name }}</a> }</div>
                } @empty { <div class="muted">nothing</div> }
                <h4>Used by ({{ disabled() ? 'unknown' : incoming().length }})</h4>
                @for (group of groupedIncoming(); track group.type) {
                  <div class="group"><span class="pill">{{ group.type }}</span> @for (item of group.items; track item.name) { <a (click)="openMember(item)">{{ item.name }}</a> }</div>
                } @empty { <div class="muted">{{ disabled() ? 'unknown while the Thing is disabled' : 'nothing' }}</div> }
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
                    <div class="view-row">
                      <div class="view">
                        @if (view() === 'graph') {
                          <se-graph-view [graph]="callGraph()" [selectedNode]="selectedNode()" (nodeClicked)="focusService($event)" (edgeHovered)="hoverEdge($event)"/>
                        } @else {
                          <se-sequence-view [tree]="root" (messageHovered)="hoverMessage($event)"/>
                        }
                      </div>
                      <div class="code-panel" [class.collapsed]="codeCollapsed()">
                        @let panel = codePanel();
                        <se-code-view [code]="panel.code" [language]="panel.language" [highlighted]="panel.lines" [title]="panel.title" [reason]="panel.reason" [(collapsed)]="codeCollapsed"/>
                      </div>
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
    .graph { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
    .sub-tabs { padding-bottom: 4px; } .graph se-graph-view { flex: 1; min-height: 0; }
    .lists { width: 260px; overflow: auto; }
    .lists h4 { margin: 8px 0 4px; } .group { margin-bottom: 6px; line-height: 1.8; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 8px; } .group .pill { margin-right: 2px; }
    a { color: #1565c0; cursor: pointer; text-decoration: underline; }
    .services { flex: 1; display: flex; gap: 12px; min-height: 0; margin-top: 8px; }
    .svc-list { width: 250px; display: flex; flex-direction: column; gap: 6px; min-height: 0; }
    .trace { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; gap: 6px; }
    .view-row { flex: 1; min-height: 0; display: flex; gap: 10px; }
    .view { flex: 1.5; min-width: 0; min-height: 0; } .code-panel { flex: 1; min-width: 300px; min-height: 0; }
    .code-panel.collapsed { flex: 0 0 30px; min-width: 30px; }
    .summary { margin: 0; }
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

  /** The picker's collection; opening a member of another kind switches it. */
  protected readonly collection = signal('Things');
  protected readonly selected = signal<EntityRow | null>(null);
  protected readonly subTab = signal<'dependencies' | 'services'>('dependencies');
  protected readonly loading = signal(false);
  protected readonly notVisible = signal(false);
  protected readonly disabled = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly inheritance = signal<InheritanceLevel[]>([]);
  /** The Dependencies sub-tab picked; an entity without inheritance always shows its other dependencies. */
  protected readonly chosenDependencyView = signal<'inheritance' | 'other'>('inheritance');
  protected readonly showDerivedThings = signal(false);
  protected readonly thingsShownLimit = DERIVED_THINGS_SHOWN;
  protected readonly derivedLimit = DERIVED_LIMIT;
  /** Collapsed code view, kept while the tab is open. */
  protected readonly codeCollapsed = signal(false);
  protected readonly dataThings = signal<Set<string>>(new Set());
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
  /** The service whose code is shown: the root unless a call-graph node was clicked. */
  protected readonly focusedService = signal<string | null>(null);
  /** A hovered call (edge or message): the caller and the lines that make the call. Wins over the focused service. */
  protected readonly hoveredCall = signal<{ callerId: string; lines: number[] } | null>(null);

  private resolver: CallResolver | null = null;
  private analysisCounter = 0;

  protected readonly hasServices = computed(() => SERVICE_COLLECTIONS.has(this.selected()?.collection ?? ''));
  protected readonly filteredServices = computed(() => {
    const filter = this.serviceFilter().toLowerCase();
    return this.services().filter((item) => (this.showBuiltin() || item.origin !== 'builtin') && item.name.toLowerCase().includes(filter));
  });
  protected readonly groupedOutgoing = computed(() => group(this.outgoing()));
  protected readonly groupedIncoming = computed(() => group(this.incoming()));

  protected readonly hasInheritance = computed(() => INHERITANCE_COLLECTIONS.has(this.selected()?.collection ?? ''));
  protected readonly inheritanceSelf = computed(() => {
    const levels = this.inheritance();
    const name = levels[0]?.name ?? this.selected()?.name;
    return name ? `level:${name}` : null;
  });

  protected readonly dependencyView = computed(() => (this.hasInheritance() ? this.chosenDependencyView() : 'other'));
  protected readonly derivedThings = computed(() => {
    const collection = this.selected()?.collection;
    return collection === 'ThingTemplates' || collection === 'ThingShapes' ? derivedThingCount(this.incoming()) : 0;
  });

  protected readonly inheritanceGraph = computed(() => {
    const entity = this.selected();
    if (!entity || !this.hasInheritance() || this.loading()) return EMPTY_GRAPH;
    const graph = buildInheritanceGraph({ name: entity.name, collection: entity.collection }, this.inheritance(), this.incoming(), this.dataThings(), { showAllThings: this.showDerivedThings() });
    return layoutInheritance(graph, this.inheritanceSelf() ?? '');
  });

  protected readonly dependencyGraph = computed(() => {
    const entity = this.selected();
    if (!entity) return EMPTY_GRAPH;
    const dataThings = this.dataThings();
    const hidden = this.hasInheritance() ? inheritanceNames(this.inheritance(), this.incoming(), entity.collection) : new Set<string>();
    const shown = (item: MemberEntity): boolean => !hidden.has(`${item.type}:${item.name}`);
    const shapeOf = (item: MemberEntity) => shapeForType(item.type, item.type === 'Thing' && dataThings.has(item.name));
    const nodes: GraphNode[] = [{ id: 'self', label: entity.name, sublabel: singular(entity.collection), kind: 'root', shape: shapeForType(entity.collection, entity.collection === 'Things' && dataThings.has(entity.name)) }];
    const edges: GraphEdge[] = [];
    this.outgoing().filter(shown).slice(0, NODE_LIMIT).forEach((item) => { nodes.push({ id: `out:${item.type}:${item.name}`, label: item.name, sublabel: item.type, kind: 'outgoing', shape: shapeOf(item) }); edges.push({ from: 'self', to: `out:${item.type}:${item.name}` }); });
    this.incoming().filter(shown).slice(0, NODE_LIMIT).forEach((item) => { nodes.push({ id: `in:${item.type}:${item.name}`, label: item.name, sublabel: item.type, kind: 'incoming', shape: shapeOf(item) }); edges.push({ from: `in:${item.type}:${item.name}`, to: 'self' }); });
    return layoutGraph(nodes, edges, 'LR');
  });

  private readonly callModel = computed(() => {
    const root = this.tree();
    return root ? perfSync('entities:build call graph', () => buildCallGraph(root, this.dataThings()), (model) => ({ nodes: model.nodes.length })) : null;
  });

  protected readonly callGraph = computed(() => {
    const model = this.callModel();
    return model ? layoutGraph(model.nodes, model.edges, 'LR') : EMPTY_GRAPH;
  });

  /** What the code view shows: a hovered call's caller with the call lines, or else the focused service. */
  protected readonly codePanel = computed(() => {
    const model = this.callModel();
    const root = this.tree();
    const hovered = this.hoveredCall();
    const id = hovered?.callerId ?? this.focusedService() ?? (root ? serviceId(root) : null);
    const node = id && model ? model.services.get(id) ?? null : null;
    if (!node) return { code: null, language: 'javascript' as const, lines: [] as number[], title: '', reason: 'Pick a service.' };
    const reason = missingCodeReason(node);
    return {
      code: reason ? null : node.code ?? null,
      language: node.language ?? 'javascript',
      lines: hovered ? hovered.lines : [],
      title: `${entityLabel(node.entity)}.${node.service}()${!reason && node.implementedBy?.name && node.implementedBy.name !== node.entity.name ? ` · from ${entityLabel(node.implementedBy)}` : ''}`,
      reason: reason ?? '',
    };
  });

  protected readonly selectedNodeInfo = computed(() => {
    const id = this.selectedNode();
    const root = this.tree();
    if (!id || !root) return null;
    const node = this.callModel()?.services.get(id) ?? null;
    if (!node) return null;
    const where = node.implementedBy?.name && node.implementedBy.name !== node.entity.name ? ` Implemented on ${entityLabel(node.implementedBy)}.` : '';
    return { title: `${entityLabel(node.entity)}.${node.service}()`, text: `${KIND_TEXT[node.kind] ?? node.kind}.${where}${node.note ? ' ' + node.note + '.' : ''}` };
  });

  constructor() {
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

  protected async choose(row: EntityRow): Promise<void> {
    this.selected.set(row);
    this.entitySelected.emit(row.name);
    this.selectedService.set(null);
    this.tree.set(null);
    this.services.set([]);
    this.outgoing.set([]);
    this.incoming.set([]);
    this.inheritance.set([]);
    this.showDerivedThings.set(false);
    this.notVisible.set(false);
    this.disabled.set(false);
    this.loadError.set(null);
    this.loading.set(true);
    if (!this.resolver) this.resolver = this.newResolver();
    const resolver = this.resolver;
    const api = this.api();
    void api.dataThings().then((names) => this.dataThings.set(names)).catch(() => undefined);
    const type = singular(row.collection);
    // Several reads ask for the same entity bodies; read each once per choice.
    const bodies = new Map<string, Promise<any | null>>();
    const read = (collection: string, name: string): Promise<any | null> => {
      const key = `${collection}/${name}`;
      let body = bodies.get(key);
      if (!body) { body = api.entity(collection, name); bodies.set(key, body); }
      return body;
    };
    const endOpen = perfStart('entities:open', { entity: `${row.collection}/${row.name}` });
    try {
      const [outgoing, incoming, services, body, levels] = await Promise.all([
        api.dependencyLookup('out', type, row.name),
        api.dependencyLookup('in', type, row.name),
        SERVICE_COLLECTIONS.has(row.collection) ? resolver.listServices({ collection: row.collection, name: row.name }) : Promise.resolve([]),
        read(row.collection, row.name),
        INHERITANCE_COLLECTIONS.has(row.collection) ? readInheritance(read, row.collection, row.name) : Promise.resolve([]),
      ]);
      if (this.selected() !== row) return;
      const isDisabled = outgoing.status === 'not-enabled' || incoming.status === 'not-enabled';
      this.disabled.set(isDisabled);
      this.outgoing.set(outgoing.status === 'not-enabled' ? dependenciesFromDefinition(row.collection, body) : outgoing.items);
      this.incoming.set(incoming.items);
      this.services.set(services);
      this.inheritance.set(levels);
      this.notVisible.set(body === null);
      endOpen({ outgoing: outgoing.items.length, incoming: incoming.items.length });
    } catch (error) {
      if (this.selected() === row) this.loadError.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.selected() === row) this.loading.set(false);
    }
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

  protected openInheritance(node: PlacedNode): void {
    if (node.id === this.inheritanceSelf() || node.id === 'derived:more') return;
    const [prefix, ...rest] = node.id.split(':');
    if (prefix === 'level') this.openMember({ type: node.sublabel ?? 'ThingTemplate', name: rest.join(':') });
    else if (prefix === 'shape') this.openMember({ type: 'ThingShape', name: rest.join(':') });
    else if (prefix === 'derived') this.openMember({ type: rest[0], name: rest.slice(1).join(':') });
  }

  protected focusService(node: PlacedNode): void {
    this.selectedNode.set(node.id);
    this.focusedService.set(node.id);
  }

  protected hoverEdge(edge: PlacedEdge | null): void {
    const lines = edge ? this.callModel()?.callLines.get(callEdgeKey(edge.from, edge.to)) : undefined;
    this.hoveredCall.set(edge && lines ? { callerId: edge.from, lines } : null);
  }

  protected hoverMessage(message: Message | null): void {
    // A return carries no lines; only calls point at code.
    this.hoveredCall.set(message && message.lines.length ? { callerId: message.callerId, lines: message.lines } : null);
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
    this.focusedService.set(null);
    this.hoveredCall.set(null);
    this.loadError.set(null);
    const endTrace = perfStart('entities:trace', { entity: `${entity.collection}/${entity.name}`, service, depth: this.depth() });
    try {
      const tree = await this.resolver.resolve({ collection: entity.collection, name: entity.name }, service, {
        maxDepth: this.depth(), onProgress: (count) => { if (ticket === this.analysisCounter) this.progress.set(count); },
      });
      endTrace({ nodes: countNodes(tree) });
      if (ticket === this.analysisCounter) this.tree.set(tree);
    } catch (error) {
      if (ticket === this.analysisCounter) this.loadError.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (ticket === this.analysisCounter) this.analysing.set(false);
    }
  }
}

function group(items: MemberEntity[]): { type: string; items: MemberEntity[] }[] {
  const byType = new Map<string, MemberEntity[]>();
  for (const item of items) byType.set(item.type, [...(byType.get(item.type) ?? []), item]);
  return [...byType.entries()].map(([type, list]) => ({ type, items: list.sort((left, right) => left.name.localeCompare(right.name)) })).sort((left, right) => left.type.localeCompare(right.type));
}
