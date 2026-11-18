import { ChangeDetectionStrategy, Component, ViewEncapsulation, computed, inject, input, output, signal, OnInit } from '@angular/core';
import { SHARED_STYLES } from './styles.ts';
import { GraphViewComponent } from './graph-view.component.ts';
import { EMPTY_GRAPH, layoutGraph } from './graph-layout.ts';
import type { GraphEdge, GraphNode, PlacedEdge, PlacedNode } from './graph-layout.ts';
import { buildExtensionGraph, memberKey } from './extension-graph.ts';
import type { ExtensionGraph, MemberEntity } from './extension-graph.ts';
import { mapWithLimit } from './twx-api.ts';
import type { TwxApi } from './twx-api.ts';

type Status = 'idle' | 'loading' | 'done' | 'error';

@Component({
  selector: 'se-extensions-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.ShadowDom,
  imports: [GraphViewComponent],
  template: `
    <div class="toolbar head">
      <button class="primary" (click)="scan()" [disabled]="status() === 'loading'">{{ status() === 'done' ? 'Rescan' : 'Scan extensions' }}</button>
      @if (status() === 'loading') {
        <button (click)="cancel()">Cancel</button>
        <progress [max]="progress().total || 1" [value]="progress().done"></progress>
        <span class="muted">{{ progress().phase }} {{ progress().done }} / {{ progress().total }}</span>
      }
      <label><input type="checkbox" [checked]="hideIsolated()" (change)="hideIsolated.set(!hideIsolated())"/> Hide extensions with no dependencies</label>
      <span class="spacer"></span>
      <span class="legend"><i class="solid"></i> uses entities of <i class="dash"></i> declared only</span>
    </div>
    @if (status() === 'error') { <p class="error">{{ error() }}</p> }
    @if (incomplete() > 0) {
      <p class="warn">{{ incomplete() }} entities could not be read (not visible to you), so some dependencies may be missing.</p>
    }
    @if (graph(); as built) {
      <div class="body">
        <div class="canvas">
          @if (placed().nodes.length) {
            <se-graph-view [graph]="placed()" [selectedNode]="selectedNode()" [selectedEdge]="selectedEdge()" (nodeClicked)="onNode($event)" (edgeClicked)="onEdge($event)"/>
          } @else {
            <p class="muted pad">No extension depends on another.</p>
          }
        </div>
        <aside>
          @if (built.cycles.length) {
            <div class="warn"><b>Circular dependencies</b>
              @for (cycle of built.cycles; track $index) { <div>{{ cycle.join(' ↔ ') }}</div> }
            </div>
          }
          @if (selectedEdgeData(); as edge) {
            <h3>{{ edge.from }} → {{ edge.to }}</h3>
            @if (edge.declared) { <p class="muted">Declared in {{ edge.from }}'s dependsOn.</p> }
            @if (edge.links.length) {
              <p class="muted">{{ edge.links.length }} entity link(s):</p>
              <table>
                @for (link of edge.links; track $index) {
                  <tr><td>{{ link.fromEntity.name }}<br><span class="pill">{{ link.fromEntity.type }}</span></td><td>→</td><td>{{ link.toEntity.name }}<br><span class="pill">{{ link.toEntity.type }}</span></td></tr>
                }
              </table>
            } @else { <p class="muted">No entity of {{ edge.from }} uses an entity of {{ edge.to }}.</p> }
          } @else if (selectedNode(); as name) {
            <h3>{{ name }}</h3>
            @if (infoFor(name); as info) {
              <p class="muted">{{ info.version }} {{ info.vendor ? '· ' + info.vendor : '' }}<br>{{ info.description }}</p>
            }
            <p><b>Depends on</b> ({{ dependsOn(name).length }})</p>
            @for (item of dependsOn(name); track item) { <div><a (click)="select(item)">{{ item }}</a></div> } @empty { <div class="muted">nothing</div> }
            <p><b>Used by</b> ({{ usedBy(name).length }})</p>
            @for (item of usedBy(name); track item) { <div><a (click)="select(item)">{{ item }}</a></div> } @empty { <div class="muted">nothing</div> }
          } @else {
            <p class="muted">Click an extension to see what it depends on and what uses it, or a link to see which entities cause it.</p>
            <p class="muted">{{ built.packages.length }} extension(s), {{ built.edges.length }} dependency link(s).</p>
          }
        </aside>
      </div>
    } @else if (status() === 'idle') {
      <p class="muted pad">Scanning reads every entity of every installed extension, which can take a while on a large platform.</p>
    }
  `,
  styles: [SHARED_STYLES, `
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .head { padding: 8px 0; }
    .body { display: flex; gap: 12px; flex: 1; min-height: 0; }
    .canvas { flex: 1; min-width: 0; display: flex; }
    .canvas > * { flex: 1; }
    aside { width: 300px; overflow: auto; border-left: 1px solid #e1e6eb; padding-left: 12px; }
    aside h3 { margin: 0 0 4px; font-size: 14px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    td { padding: 4px 4px; border-top: 1px solid #eef1f4; vertical-align: top; word-break: break-all; }
    a { color: #1565c0; cursor: pointer; text-decoration: underline; }
    .pad { padding: 12px 0; }
    .legend { color: #6b7782; font-size: 12px; }
    .legend i { display: inline-block; width: 26px; border-top: 2px solid #8794a1; vertical-align: middle; margin: 0 4px 0 10px; }
    .legend i.dash { border-top-style: dashed; }
    progress { width: 160px; }
  `],
})
export class ExtensionsTabComponent implements OnInit {
  readonly api = input.required<TwxApi>();
  readonly extensionSelected = output<string>();

  protected readonly status = signal<Status>('idle');
  protected readonly error = signal('');
  protected readonly progress = signal({ phase: '', done: 0, total: 0 });
  protected readonly graph = signal<ExtensionGraph | null>(null);
  protected readonly incomplete = signal(0);
  protected readonly hideIsolated = signal(false);
  protected readonly selectedNode = signal<string | null>(null);
  protected readonly selectedEdge = signal<string | null>(null);
  private cancelled = false;

  protected readonly placed = computed(() => {
    const built = this.graph();
    if (!built) return EMPTY_GRAPH;
    const connected = new Set<string>();
    built.edges.forEach((edge) => { connected.add(edge.from); connected.add(edge.to); });
    const nodes: GraphNode[] = built.packages
      .filter((item) => !this.hideIsolated() || connected.has(item.name))
      .map((item) => ({ id: item.name, label: item.name, sublabel: item.version, kind: 'package' }));
    built.missing.forEach((name) => nodes.push({ id: name, label: name, sublabel: 'not installed', kind: 'absent' }));
    const edges: GraphEdge[] = built.edges.map((edge) => ({
      from: edge.from, to: edge.to, label: edge.links.length ? String(edge.links.length) : undefined, kind: edge.links.length ? 'used' : 'declared',
    }));
    built.packages.forEach((item) => item.dependsOn.filter((name) => built.missing.includes(name)).forEach((name) => edges.push({ from: item.name, to: name, kind: 'declared' })));
    return layoutGraph(nodes, edges, 'LR');
  });

  protected readonly selectedEdgeData = computed(() => {
    const [from, to] = (this.selectedEdge() ?? '').split('->');
    return this.graph()?.edges.find((edge) => edge.from === from && edge.to === to) ?? null;
  });

  ngOnInit(): void {
    void this.scan();
  }

  protected cancel(): void { this.cancelled = true; }

  protected infoFor(name: string) { return this.graph()?.packages.find((item) => item.name === name); }
  protected dependsOn(name: string): string[] { return (this.graph()?.edges ?? []).filter((edge) => edge.from === name).map((edge) => edge.to).concat(this.infoFor(name)?.dependsOn.filter((dependency) => this.graph()?.missing.includes(dependency)) ?? []); }
  protected usedBy(name: string): string[] { return (this.graph()?.edges ?? []).filter((edge) => edge.to === name).map((edge) => edge.from); }

  protected onNode(node: PlacedNode): void { this.select(node.id); }
  protected onEdge(edge: PlacedEdge): void {
    this.selectedNode.set(null);
    this.selectedEdge.set(`${edge.from}->${edge.to}`);
  }

  protected select(name: string): void {
    this.selectedEdge.set(null);
    this.selectedNode.set(name);
    this.extensionSelected.emit(name);
  }

  protected async scan(): Promise<void> {
    this.cancelled = false;
    this.status.set('loading');
    this.error.set('');
    this.incomplete.set(0);
    this.selectedEdge.set(null);
    try {
      const api = this.api();
      this.progress.set({ phase: 'Reading extensions', done: 0, total: 0 });
      const packages = await api.packages();
      const members = new Map<string, MemberEntity[]>();
      let done = 0;
      this.progress.set({ phase: 'Listing entities', done, total: packages.length });
      await mapWithLimit(packages, 4, async (item) => {
        members.set(item.name, await api.packageEntities(item.name));
        this.progress.update((value) => ({ ...value, done: ++done }));
      }, () => this.cancelled);
      const everyMember = [...members.values()].flat();
      const outgoing = new Map<string, MemberEntity[]>();
      done = 0;
      let unreadable = 0;
      this.progress.set({ phase: 'Reading dependencies', done, total: everyMember.length });
      await mapWithLimit(everyMember, 8, async (member) => {
        const used = await api.dependencies('out', member.type, member.name);
        if (used) outgoing.set(memberKey(member), used);
        else unreadable += 1;
        this.progress.update((value) => ({ ...value, done: ++done }));
      }, () => this.cancelled);
      this.incomplete.set(this.cancelled ? 0 : unreadable);
      this.graph.set(buildExtensionGraph(packages, members, outgoing));
      this.status.set('done');
    } catch (failure) {
      this.error.set(failure instanceof Error ? failure.message : String(failure));
      this.status.set('error');
    }
  }
}
