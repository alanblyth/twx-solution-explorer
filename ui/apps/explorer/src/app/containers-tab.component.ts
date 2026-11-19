import { ChangeDetectionStrategy, Component, ViewEncapsulation, computed, effect, input, output, signal, untracked } from '@angular/core';
import { SHARED_STYLES } from './styles.ts';
import { GraphViewComponent } from './graph-view.component.ts';
import { PermissionsPanelComponent } from './permissions-panel.component.ts';
import { EMPTY_GRAPH, layoutGraph } from './graph-layout.ts';
import type { PlacedEdge, PlacedNode } from './graph-layout.ts';
import { buildContainerGraph, callTargets, NO_OWNER } from './container-graph.ts';
import type { ContainerLink } from './container-graph.ts';
import { memberKey } from './extension-graph.ts';
import type { MemberEntity } from './extension-graph.ts';
import { dependenciesFromDefinition } from './inheritance.ts';
import { implementationsOf } from './call-resolver.ts';
import { analyzeScript, flattenCalls } from './js-analyzer.ts';
import { collectionOfType } from './models.ts';
import { mapWithLimit, unreadableEntity } from './twx-api.ts';
import { withLinks } from './mashup-content.ts';
import { containerMembersFor, dedupeEntities } from './container-members.ts';
import type { ContainerKind } from './container-members.ts';
import type { TwxApi, UnreadableEntity } from './twx-api.ts';
import { perfStart, perfSync } from './perf.ts';

export type { ContainerKind };
export interface ContainerRequest { kind: ContainerKind; name: string }
export interface EntityRequest { name: string; collection: string }

type Status = 'idle' | 'loading' | 'done' | 'error';

/** What one scan of a container read; the graph is built from it, so grouping can change without a rescan. */
interface ScanResult {
  kind: ContainerKind;
  name: string;
  members: MemberEntity[];
  outgoing: Map<string, MemberEntity[]>;
  incoming: Map<string, MemberEntity[]> | null;
  calls: Map<string, MemberEntity[]> | null;
  owners: Map<string, string>;
  dataThings: Set<string>;
  /** Entities the scan could not read, and why. */
  unreadable: UnreadableEntity[];
  readFromDefinition: number;
  scriptsWithErrors: number;
}

const SCRIPT_HOLDER_TYPES = new Set(['Thing', 'ThingTemplate', 'ThingShape']);
const MAX_LISTED = 300;

/** The Projects & Extensions tab: the entities in one project or extension, how they relate to each other and to everything outside. */
@Component({
  selector: 'se-containers-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.ShadowDom,
  imports: [GraphViewComponent, PermissionsPanelComponent],
  template: `
    <div class="toolbar head">
      <select [value]="kind()" (change)="setKind($any($event.target).value)">
        <option value="Project">Project</option>
        <option value="Extension">Extension</option>
      </select>
      <input class="filter" placeholder="Filter {{ kind() === 'Project' ? 'projects' : 'extensions' }}" [value]="filterText()" (input)="filterText.set($any($event.target).value)"/>
      <button class="primary" (click)="scan()" [disabled]="!chosen() || status() === 'loading'">{{ scanned()?.name === chosen() && scanned()?.kind === kind() ? 'Rescan' : 'Scan' }}</button>
      @if (status() === 'loading') {
        <button (click)="cancel()">Cancel</button>
        <progress [max]="progress().total || 1" [value]="progress().done"></progress>
        <span class="muted">{{ progress().phase }} {{ progress().done }} / {{ progress().total }}</span>
      }
      <span class="spacer"></span>
      <label title="Read what uses each entity (one more call per entity)"><input type="checkbox" [checked]="showIncoming()" (change)="showIncoming.set(!showIncoming())"/> Show what uses it</label>
      <label title="Read the scripts of Things, templates and shapes for calls to other entities"><input type="checkbox" [checked]="includeCalls()" (change)="includeCalls.set(!includeCalls())"/> Include script calls</label>
      <label><input type="checkbox" [checked]="groupOutside()" (change)="groupOutside.set(!groupOutside())"/> Group outside by {{ kind() === 'Project' ? 'project' : 'extension' }}</label>
    </div>
    @if (status() === 'error') { <p class="error">{{ error() }}</p> }
    @if (needsRescan()) { <p class="warn">Scan again to apply the changed options.</p> }
    <div class="body">
      <div class="chooser">
        @if (optionsLoading()) { <p class="muted">Loading…</p> }
        @for (name of filteredOptions(); track name) {
          <div class="option" [class.chosen]="name === chosen()" (click)="choose(name)">{{ name }}</div>
        } @empty { @if (!optionsLoading()) { <p class="muted">No {{ kind() === 'Project' ? 'project' : 'extension' }} matches.</p> } }
        @if (optionCount() > filteredOptions().length) { <p class="muted">{{ optionCount() - filteredOptions().length }} more; filter to narrow.</p> }
      </div>
      <div class="canvas">
        @if (placed().nodes.length) {
          <se-graph-view [graph]="placed()" [selectedNode]="selectedNode()" [selectedEdge]="selectedEdge()" (nodeClicked)="onNode($event)" (nodeOpened)="onNodeOpened($event)" (edgeClicked)="onEdge($event)"/>
        } @else if (scanned(); as result) {
          <p class="muted pad">{{ result.kind }} {{ result.name }} has no entities you can see.</p>
        } @else {
          <p class="muted pad">Pick a project or an extension to scan it and see how its entities relate to each other and to everything outside it.</p>
        }
      </div>
      @if (scanned(); as result) {
        <aside>
          @if (result.unreadable.length) {
            <div class="warn">{{ result.unreadable.length }} entit{{ result.unreadable.length === 1 ? 'y' : 'ies' }} could not be read, so some links may be missing.
              <details><summary>Which</summary>@for (entity of result.unreadable; track $index) { <div>{{ entity.name }} <span class="pill">{{ entity.type }}</span> <span class="muted">{{ entity.reason }}</span></div> }</details>
            </div>
          }
          @if (result.readFromDefinition) { <p class="muted">{{ result.readFromDefinition }} disabled Thing(s) read from their definition (template, shapes, value stream, data shapes and configuration).</p> }
          @if (result.scriptsWithErrors) { <p class="muted">{{ result.scriptsWithErrors }} script(s) did not parse; their calls were found by pattern matching.</p> }
          @if (selectedEdge()) {
            <h3>{{ labelOf(selectedEdgeEnds()[0]) }} → {{ labelOf(selectedEdgeEnds()[1]) }}</h3>
      <table>
        @for (link of selectedLinks(); track $index) {
          <tr>
            <td><a (click)="openLinked(link.from)">{{ link.from.name }}</a><br><span class="pill">{{ link.from.type }}</span></td>
            <td>{{ link.kind === 'calls' ? 'calls' : '→' }}</td>
            <td><a (click)="openLinked(link.to)">{{ link.to.name }}</a><br><span class="pill">{{ link.to.type }}</span></td>
          </tr>
        }
      </table>
            <p class="muted">{{ selectedLinks().length }} link(s).</p>
          } @else if (selectedNode(); as nodeId) {
            <h3>{{ labelOf(nodeId) }}</h3>
            @if (entityOf(nodeId); as entity) {
              <p><span class="pill">{{ entity.type }}</span> {{ ownerText(entity) }}</p>
              <p><button (click)="openEntity.emit({ name: entity.name, collection: collectionOf(entity.type) })">Open in Entities tab</button></p>
            } @else if (ownerNodeName(nodeId); as owner) {
              @if (owner !== noOwner) { <p><button (click)="openContainer(result.kind, owner)">Show contents</button></p> }
              @else { <p class="muted">Platform entities and entities that belong to no {{ result.kind === 'Project' ? 'project' : 'extension' }}.</p> }
            }
            <p><b>Links</b> ({{ selectedLinks().length }})</p>
            @for (link of selectedLinks(); track $index) {
              <div class="link"><a (click)="openLinked(link.from)">{{ link.from.name }}</a> → <a (click)="openLinked(link.to)">{{ link.to.name }}</a> <span class="pill">{{ link.kind }}</span></div>
            } @empty { <div class="muted">none</div> }
          } @else {
            <h3>{{ result.kind }} {{ result.name }}</h3>
            <p class="muted">{{ result.members.length }} entit{{ result.members.length === 1 ? 'y' : 'ies' }}. Click a node or a link to list its links; double-click an entity to open it in the Entities tab.</p>
            <table class="counts">
              <tr><td>Internal links</td><td>{{ counts().internal }}</td></tr>
              <tr><td>Outgoing links</td><td>{{ counts().outgoing }}</td></tr>
              <tr><td>Incoming links</td><td>{{ result.incoming ? counts().incoming : 'not read' }}</td></tr>
            </table>
            <p><b>Outside {{ result.kind === 'Project' ? 'projects' : 'extensions' }}</b> ({{ built().outside.length }})</p>
            <table class="counts">
              <tr class="muted"><td></td><td>out</td><td>in</td></tr>
              @for (item of built().outside; track item.owner) {
                <tr>
                  <td>@if (item.owner === noOwner) { <span class="muted">{{ item.owner }}</span> } @else { <a (click)="selectOwner(item.owner)">{{ item.owner }}</a> }</td>
                  <td>{{ item.outgoing }}</td><td>{{ item.incoming }}</td>
                </tr>
              } @empty { <tr><td class="muted" colspan="3">nothing outside</td></tr> }
            </table>
          }
        </aside>
      }
    </div>
    <se-permissions-panel [api]="api()" [entity]="selectedEntity()" [(open)]="permissionsOpen" (openEntity)="openLinked($event)"/>
  `,
  styles: [SHARED_STYLES, `
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .head { padding: 8px 0; }
    .filter { width: 200px; }
    .body { display: flex; gap: 12px; flex: 1; min-height: 0; }
    .chooser { width: 220px; overflow: auto; border-right: 1px solid #e1e6eb; padding-right: 8px; }
    .option { padding: 3px 6px; border-radius: 4px; cursor: pointer; word-break: break-all; }
    .option:hover { background: #eef2f6; }
    .option.chosen { background: #d6e8fb; font-weight: 600; }
    .canvas { flex: 1; min-width: 0; display: flex; }
    .canvas > * { flex: 1; }
    aside { width: 300px; overflow: auto; border-left: 1px solid #e1e6eb; padding-left: 12px; }
    aside h3 { margin: 0 0 4px; font-size: 14px; word-break: break-all; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    td { padding: 4px 4px; border-top: 1px solid #eef1f4; vertical-align: top; word-break: break-all; }
    .counts td:not(:first-child) { text-align: right; min-width: 44px; white-space: nowrap; word-break: normal; }
    .link { font-size: 12px; padding: 3px 0; border-top: 1px solid #eef1f4; word-break: break-all; }
    a { color: #1565c0; cursor: pointer; text-decoration: underline; }
    .pad { padding: 12px 0; }
    progress { width: 140px; }
    details { margin-top: 4px; font-size: 12px; }
  `],
})
export class ContainersTabComponent {
  readonly api = input.required<TwxApi>();
  /** A project or extension to open and scan, from the widget, a deep link or another tab. */
  readonly request = input<ContainerRequest | null>(null);
  readonly openEntity = output<EntityRequest>();
  readonly containerSelected = output<string>();

  protected readonly noOwner = NO_OWNER;
  protected readonly kind = signal<ContainerKind>('Project');
  protected readonly filterText = signal('');
  protected readonly chosen = signal<string | null>(null);
  protected readonly showIncoming = signal(false);
  protected readonly includeCalls = signal(true);
  protected readonly groupOutside = signal(true);
  protected readonly status = signal<Status>('idle');
  protected readonly error = signal('');
  protected readonly progress = signal({ phase: '', done: 0, total: 0 });
  protected readonly scanned = signal<ScanResult | null>(null);
  protected readonly selectedNode = signal<string | null>(null);
  protected readonly selectedEdge = signal<string | null>(null);
  protected readonly optionsLoading = signal(false);
  /** The permissions bar at the bottom, and the entity it shows: the selected entity node. */
  protected readonly permissionsOpen = signal(false);
  protected readonly selectedEntity = computed(() => {
    const nodeId = this.selectedNode();
    return nodeId ? this.entityOf(nodeId) : null;
  });
  private readonly projectNames = signal<string[] | null>(null);
  private readonly packageNames = signal<string[] | null>(null);
  private cancelled = false;
  private scanTicket = 0;

  private readonly options = computed(() => (this.kind() === 'Project' ? this.projectNames() : this.packageNames()) ?? []);
  private readonly matchingOptions = computed(() => {
    const needle = this.filterText().trim().toLowerCase();
    return needle ? this.options().filter((name) => name.toLowerCase().includes(needle)) : this.options();
  });
  protected readonly optionCount = computed(() => this.matchingOptions().length);
  protected readonly filteredOptions = computed(() => this.matchingOptions().slice(0, MAX_LISTED));

  protected readonly needsRescan = computed(() => {
    const result = this.scanned();
    if (!result || this.status() === 'loading') return false;
    return (this.showIncoming() && !result.incoming) || (this.includeCalls() && !result.calls);
  });

  protected readonly built = computed(() => {
    const result = this.scanned();
    if (!result) return { nodes: [], edges: [], groups: [], links: [], outside: [] };
    return perfSync('containers:build graph', () => buildContainerGraph({
      containerKind: result.kind, containerName: result.name, members: result.members, outgoing: result.outgoing,
      incoming: this.showIncoming() ? result.incoming : null, calls: this.includeCalls() ? result.calls : null,
      ownerOf: (entity) => result.owners.get(memberKey(entity)) ?? null, groupOutside: this.groupOutside(), dataThings: result.dataThings,
    }), (graph) => ({ nodes: graph.nodes.length, links: graph.links.length }));
  });

  protected readonly placed = computed(() => {
    const graph = this.built();
    return graph.nodes.length ? layoutGraph(graph.nodes, graph.edges, 'LR', graph.groups) : EMPTY_GRAPH;
  });

  protected readonly counts = computed(() => {
    const tally = { internal: 0, outgoing: 0, incoming: 0 };
    for (const link of this.built().links) tally[link.scope] += 1;
    return tally;
  });

  protected readonly selectedEdgeEnds = computed(() => (this.selectedEdge() ?? '').split('->'));

  protected readonly selectedLinks = computed<ContainerLink[]>(() => {
    const links = this.built().links;
    const edge = this.selectedEdge();
    if (edge) {
      const [fromId, toId] = edge.split('->');
      return links.filter((link) => this.fromNodeId(link) === fromId && this.toNodeId(link) === toId);
    }
    const nodeId = this.selectedNode();
    if (!nodeId) return [];
    return links.filter((link) => this.fromNodeId(link) === nodeId || this.toNodeId(link) === nodeId);
  });

  constructor() {
    effect(() => {
      const kind = this.kind();
      untracked(() => void this.loadOptions(kind));
    });
    effect(() => {
      const request = this.request();
      if (!request?.name) return;
      untracked(() => this.openContainer(request.kind, request.name));
    });
  }

  protected setKind(kind: ContainerKind): void {
    this.kind.set(kind);
    this.chosen.set(null);
    this.filterText.set('');
  }

  /** Picking a project or extension scans it, unless it is the one already shown or being scanned (Rescan reads it again). */
  protected choose(name: string): void {
    const result = this.scanned();
    const alreadyShown = name === this.chosen() && (this.status() === 'loading' || (result?.name === name && result.kind === this.kind()));
    this.chosen.set(name);
    if (!alreadyShown) void this.scan();
  }

  protected cancel(): void { this.cancelled = true; }

  /** Opens a project or extension in this tab and scans it. */
  protected openContainer(kind: ContainerKind, name: string): void {
    this.kind.set(kind);
    this.filterText.set('');
    this.chosen.set(name);
    void this.scan();
  }

  protected selectOwner(owner: string): void {
    if (this.groupOutside()) this.selectNode(`c:${owner}`);
  }

  protected onNode(node: PlacedNode): void { this.selectNode(node.id); }

  protected onNodeOpened(node: PlacedNode): void {
    const entity = this.entityOf(node.id);
    if (entity) this.openEntity.emit({ name: entity.name, collection: collectionOfType(entity.type) });
    else {
      const owner = this.ownerNodeName(node.id);
      const result = this.scanned();
      if (owner && owner !== NO_OWNER && result) this.openContainer(result.kind, owner);
    }
  }

  protected onEdge(edge: PlacedEdge): void {
    this.selectedNode.set(null);
    this.selectedEdge.set(`${edge.from}->${edge.to}`);
  }

  private selectNode(nodeId: string): void {
    this.selectedEdge.set(null);
    this.selectedNode.set(this.selectedNode() === nodeId ? null : nodeId);
  }

  protected openLinked(entity: MemberEntity): void {
    this.openEntity.emit({ name: entity.name, collection: collectionOfType(entity.type) });
  }

  protected collectionOf(type: string): string { return collectionOfType(type); }

  /** The entity of a node id `e:<type>:<name>`, or null for an owner node. */
  protected entityOf(nodeId: string): MemberEntity | null {
    if (!nodeId.startsWith('e:')) return null;
    const rest = nodeId.slice(2);
    const separator = rest.indexOf(':');
    return { type: rest.slice(0, separator), name: rest.slice(separator + 1) };
  }

  protected ownerNodeName(nodeId: string): string | null {
    return nodeId.startsWith('c:') ? nodeId.slice(2) : null;
  }

  protected labelOf(nodeId: string | undefined): string {
    if (!nodeId) return '';
    return this.entityOf(nodeId)?.name ?? this.ownerNodeName(nodeId) ?? nodeId;
  }

  protected ownerText(entity: MemberEntity): string {
    const result = this.scanned();
    if (!result) return '';
    if (result.members.some((member) => memberKey(member) === memberKey(entity))) return `in ${result.kind} ${result.name}`;
    const owner = result.owners.get(memberKey(entity));
    return owner ? `in ${owner}` : `in no ${result.kind === 'Project' ? 'project' : 'extension'}`;
  }

  // Node ids as buildContainerGraph gives them: e:<type>:<name> for an entity, c:<owner> for a grouped outside owner.
  private fromNodeId(link: ContainerLink): string {
    return link.scope === 'incoming' && this.groupOutside() ? `c:${link.outsideOwner}` : `e:${memberKey(link.from)}`;
  }

  private toNodeId(link: ContainerLink): string {
    return link.scope === 'outgoing' && this.groupOutside() ? `c:${link.outsideOwner}` : `e:${memberKey(link.to)}`;
  }

  private async loadOptions(kind: ContainerKind): Promise<void> {
    const target = kind === 'Project' ? this.projectNames : this.packageNames;
    if (target()) return;
    this.optionsLoading.set(true);
    try {
      target.set(await containerMembersFor(this.api()).names(kind));
    } catch (failure) {
      this.error.set(failure instanceof Error ? failure.message : String(failure));
      this.status.set('error');
    } finally {
      this.optionsLoading.set(false);
    }
  }

  protected async scan(): Promise<void> {
    const name = this.chosen();
    if (!name) return;
    const kind = this.kind();
    const ticket = ++this.scanTicket;
    const stale = (): boolean => this.cancelled || ticket !== this.scanTicket;
    this.cancelled = false;
    this.status.set('loading');
    this.error.set('');
    this.selectedNode.set(null);
    this.selectedEdge.set(null);
    this.containerSelected.emit(name);
    const readIncoming = this.showIncoming();
    const readCalls = this.includeCalls();
    try {
      const api = this.api();
      const endScan = perfStart('containers:scan', { kind, name, incoming: readIncoming, calls: readCalls });
      let endPhase = perfStart('containers:list entities');
      this.progress.set({ phase: 'Listing entities', done: 0, total: 0 });
      // A scan reads afresh (and refreshes what the entity picker filters by).
      const containers = containerMembersFor(api);
      const members = await containers.members(kind, name, true);

      // Who owns every other entity: each project's entities, or each extension's.
      endPhase({ members: members.length });
      endPhase = perfStart('containers:read other containers');
      const phase = `Reading other ${kind === 'Project' ? 'projects' : 'extensions'}`;
      const owners = await containers.ownerMap(kind, name, {
        fresh: true, shouldStop: stale, onProgress: (done, total) => this.progress.set({ phase, done, total }),
      });
      if (stale()) return this.stopped(ticket);
      endPhase({ owned: owners.size });
      endPhase = perfStart('containers:read dependencies');
      let analysisMilliseconds = 0;
      let done = 0;

      // Each member's body is read at most once and not kept: a big project has thousands of bodies of about 230 kB.
      // The read is fresh (a scan shows the platform as it is now): it refreshes a body the shared cache already holds and
      // adds none, so the scan neither keeps thousands of bodies nor pushes out what the Entities tab is showing.
      const bodyFailures = new Map<string, string>();   // member key: the platform's error when its body could not be read
      const readBody = (member: MemberEntity): Promise<any | null> =>
        api.entity(collectionOfType(member.type), member.name, { fresh: true }).catch((error) => {
          bodyFailures.set(memberKey(member), `the platform failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
      const outgoing = new Map<string, MemberEntity[]>();
      const incoming = readIncoming ? new Map<string, MemberEntity[]>() : null;
      const calls = readCalls ? new Map<string, MemberEntity[]>() : null;
      const unreadable: UnreadableEntity[] = [];
      let readFromDefinition = 0;
      let scriptsWithErrors = 0;
      done = 0;
      this.progress.set({ phase: 'Reading dependencies', done, total: members.length });
      await mapWithLimit(members, 8, async (member) => {
        const key = memberKey(member);
        const wantsScripts = calls !== null && SCRIPT_HOLDER_TYPES.has(member.type);
        let body: any | null | undefined;   // undefined: not read yet; null: missing or not visible
        let visible = true;
        if (wantsScripts && member.type === 'Thing') {
          // The body is read for the scripts anyway, and it names everything GetOutgoingDependencies lists for a Thing
          // (dependenciesFromDefinition), so one request does both, and a disabled Thing needs no second try.
          body = await readBody(member);
          if (body) {
            outgoing.set(key, dependenciesFromDefinition('Things', body));
            if (body.enabled === false || body.enabled === 'false') readFromDefinition += 1;
          } else {
            unreadable.push({ ...member, reason: bodyFailures.get(key) ?? 'not visible to you' });
            visible = false;
          }
        } else {
          const lookup = await api.dependencyLookup('out', member.type, member.name);
          // A mashup's widgets are missing from GetOutgoingDependencies; its content names them (mashup-content.ts).
          if (lookup.status === 'ok') outgoing.set(key, withLinks(lookup.items, await api.contentLinks('out', member.type, member.name)));
          else if (lookup.status === 'not-enabled') {
            body = await readBody(member);
            if (body) { outgoing.set(key, dependenciesFromDefinition(collectionOfType(member.type), body)); readFromDefinition += 1; }
            else unreadable.push(unreadableEntity(member, lookup));
          } else {
            unreadable.push(unreadableEntity(member, lookup));
            // A failed lookup is the platform's fault for this one entity; its scripts can still be read.
            visible = lookup.status === 'failed';
          }
        }
        if (incoming) {
          const users = await api.dependencyLookup('in', member.type, member.name);
          if (users.status === 'ok') incoming.set(key, withLinks(users.items, await api.contentLinks('in', member.type, member.name)));
        }
        if (calls && wantsScripts && visible) {
          if (body === undefined) body = await readBody(member);
          const found: MemberEntity[] = [];
          for (const implementation of Object.values<any>(implementationsOf(body))) {
            if (implementation?.handlerName !== 'Script') continue;
            const code = implementation.configurationTables?.Script?.rows?.[0]?.code;
            if (typeof code !== 'string' || !code.trim()) continue;
            const analysisStarted = performance.now();
            const analysis = analyzeScript(code);
            analysisMilliseconds += performance.now() - analysisStarted;
            if (analysis.parseError) scriptsWithErrors += 1;
            found.push(...callTargets(flattenCalls(analysis.steps)));
          }
          calls.set(key, dedupeEntities(found));
        }
        this.progress.update((value) => ({ ...value, done: ++done }));
      }, stale);
      if (stale()) return this.stopped(ticket);

      endPhase({ members: members.length, analysisMilliseconds: Math.round(analysisMilliseconds) });
      const dataThings = await api.dataThings();
      endScan({ members: members.length });
      this.scanned.set({ kind, name, members, outgoing, incoming, calls, owners, dataThings, unreadable, readFromDefinition, scriptsWithErrors });
      this.status.set('done');
    } catch (failure) {
      if (ticket !== this.scanTicket) return;
      this.error.set(failure instanceof Error ? failure.message : String(failure));
      this.status.set('error');
    }
  }

  private stopped(ticket: number): void {
    if (ticket === this.scanTicket) this.status.set(this.scanned() ? 'done' : 'idle');
  }
}
