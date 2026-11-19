import { ChangeDetectionStrategy, Component, ViewEncapsulation, computed, effect, input, output, signal, untracked } from '@angular/core';
import { SHARED_STYLES } from './styles.ts';
import { GraphViewComponent } from './graph-view.component.ts';
import { EMPTY_GRAPH, layoutGraph } from './graph-layout.ts';
import type { GraphEdge, GraphNode, PlacedNode } from './graph-layout.ts';
import { KIND_LABEL, SecurityModel, parseRefKey, refKey } from './security-model.ts';
import type { EntityPermissionRow, SecurityKind, SecurityLink, SecurityRef } from './security-model.ts';
import { SYSTEM_USER } from './permissions.ts';
import { collectionOfType } from './models.ts';
import type { TwxApi } from './twx-api.ts';
import type { EntityRequest } from './containers-tab.component.ts';

const PICKER_KINDS: SecurityKind[] = ['Organization', 'OrganizationalUnit', 'Group', 'User', 'Role', 'PermissionGroup'];
const MAX_LISTED = 400;
/** Collections the Entities tab can show. */
const OPENABLE = new Set(['Things', 'ThingTemplates', 'ThingShapes', 'DataShapes', 'Mashups', 'Projects']);

/** The Security tab: organisations and their unit trees, user groups, users, roles and permission groups, and how they link. */
@Component({
  selector: 'se-security-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.ShadowDom,
  imports: [GraphViewComponent],
  template: `
    <div class="layout">
      <div class="picker">
        <div class="toolbar">
          <select (change)="kind.set($any($event.target).value)">
            @for (option of pickerKinds; track option) { <option [value]="option" [selected]="option === kind()">{{ kindLabel[option] }}s</option> }
          </select>
          <button (click)="reload()" title="Read the security entities again">Reload</button>
        </div>
        <input type="search" placeholder="Filter by name" [value]="filter()" (input)="filter.set($any($event.target).value)"/>
        <div class="results">
          <div class="row" [class.on]="!selected()" (click)="select(null)"><span class="name">Overview</span><span class="muted">roles and units</span></div>
          @for (name of shownNames(); track name) {
            <div class="row" [class.on]="selected()?.kind === kind() && selected()?.name === name" (click)="select({ kind: kind(), name })">
              <span class="name">{{ name }}</span><span class="desc muted">{{ model()?.description({ kind: kind(), name }) }}</span>
            </div>
          } @empty { <p class="muted pad">{{ status() === 'loading' ? 'Loading…' : 'None.' }}</p> }
          @if (matchingNames().length > shownNames().length) { <p class="muted pad">{{ matchingNames().length - shownNames().length }} more; filter to narrow.</p> }
        </div>
      </div>

      <section class="canvas">
        <div class="toolbar">
          @if (selected(); as current) {
            <h2>{{ current.name }}</h2><span class="pill">{{ kindLabel[current.kind] }}</span>
            <span class="spacer"></span>
            <label>Held by <select (change)="upDepth.set(+$any($event.target).value)">@for (depth of depths; track depth) { <option [value]="depth" [selected]="depth === upDepth()">{{ depth === 0 ? 'hide' : depth + ' level' + (depth === 1 ? '' : 's') }}</option> }</select></label>
            <label>Holds <select (change)="downDepth.set(+$any($event.target).value)">@for (depth of depths; track depth) { <option [value]="depth" [selected]="depth === downDepth()">{{ depth === 0 ? 'hide' : depth + ' level' + (depth === 1 ? '' : 's') }}</option> }</select></label>
          } @else {
            <h2>Overview</h2><span class="muted">every role with what it holds, every organisation with its units, and nested permission groups</span>
          }
        </div>
        @if (status() === 'error') { <p class="warn error">{{ error() }}</p> }
        @if (status() === 'denied') { <p class="warn">Roles, permission groups, user groups and organisations could not be read. Reading them needs an administrator.</p> }
        @if (truncated()) { <p class="warn">Too many links to draw them all; lower the levels or pick something narrower.</p> }
        @if (graph().nodes.length) {
          <se-graph-view [graph]="graph()" [selectedNode]="selected() ? refKey(selected()!) : null" (nodeClicked)="onNode($event)"/>
        } @else if (status() === 'done') { <p class="muted pad">Nothing links to or from it.</p> }
        <p class="muted legend">Arrows read "contained in": a user or group points to the groups, units and roles that hold it, a unit to its parent unit or organisation, and a permission group to the groups and roles that include it. Green holds the selection, blue is held by it. Click a node to select it.</p>
      </section>

      @if (selected(); as current) {
        <aside>
          @if (model()?.description(current); as description) { <p class="muted">{{ description }}</p> }
          @if (current.kind === 'User' && current.name === systemUser) { <p class="warn">System: services' calls to other entities succeed on its rights (notes section 1).</p> }
          <h4>Directly held by ({{ directUp().length }})</h4>
          @for (link of directUp(); track $index) { <div class="link"><span class="pill">{{ kindLabel[link.from.kind] }}</span> <a (click)="select(link.from)">{{ link.from.name }}</a></div> } @empty { <div class="muted">nothing</div> }
          <h4>Directly holds ({{ directDown().length }})</h4>
          @for (link of directDown(); track $index) { <div class="link"><span class="pill">{{ kindLabel[link.to.kind] }}</span> <a (click)="select(link.to)">{{ link.to.name }}</a></div> } @empty { <div class="muted">nothing</div> }
          @if (throughRoles().length) {
            <h4>{{ current.kind === 'PermissionGroup' ? 'Users and groups that get it through roles' : 'Permission groups it gets through roles' }} ({{ throughRoles().length }})</h4>
            @for (ref of throughRoles(); track refKey(ref)) { <div class="link"><span class="pill">{{ kindLabel[ref.kind] }}</span> <a (click)="select(ref)">{{ ref.name }}</a></div> }
          }
          <details>
            <summary>Everything that holds it, however indirectly ({{ allUp().length }})</summary>
            @for (ref of allUp(); track refKey(ref)) { <div class="link"><span class="pill">{{ kindLabel[ref.kind] }}</span> <a (click)="select(ref)">{{ ref.name }}</a></div> }
          </details>
          <details>
            <summary>Everything it holds, however indirectly ({{ allDown().length }})</summary>
            @for (ref of allDown(); track refKey(ref)) { <div class="link"><span class="pill">{{ kindLabel[ref.kind] }}</span> <a (click)="select(ref)">{{ ref.name }}</a></div> }
          </details>
          @if (current.kind === 'PermissionGroup') {
            <h4>Grants ({{ grants().length }}) <span class="muted">directly, not through nested groups</span></h4>
            <table>
              <tr class="muted"><td>Entity</td><td>Permission</td><td></td></tr>
              @for (row of grants(); track $index) {
                <tr [class.deny]="!row.permitted">
                  <td>@if (openable(row)) { <a (click)="openGrant(row)">{{ row.entityName }}</a> } @else { {{ row.entityName }} } <br><span class="pill">{{ row.entityType }}{{ row.scope === 'instances' ? ' · its Things' : '' }}</span></td>
                  <td>{{ row.category }} {{ row.permission }}@if (row.resource) { <br><span class="muted">{{ row.resource }}</span> }</td>
                  <td>{{ row.permitted ? 'allow' : 'deny' }}</td>
                </tr>
              } @empty { <tr><td colspan="3" class="muted">none</td></tr> }
            </table>
          }
        </aside>
      }
    </div>
  `,
  styles: [SHARED_STYLES, `
    :host { display: block; height: 100%; min-height: 0; }
    .layout { display: flex; gap: 12px; height: 100%; min-height: 0; padding-top: 8px; }
    .picker { width: 270px; display: flex; flex-direction: column; gap: 6px; min-height: 0; }
    .picker select { flex: 1; }
    .results { flex: 1; overflow: auto; border: 1px solid #d5dce3; border-radius: 4px; min-height: 0; }
    .row { display: flex; gap: 6px; align-items: baseline; padding: 4px 8px; cursor: pointer; border-bottom: 1px solid #f0f3f6; }
    .row:hover { background: #f3f7fb; } .row.on { background: #d6e8fb; }
    .row .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .row .desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; font-size: 11.5px; }
    .canvas { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; gap: 6px; }
    .canvas h2 { margin: 0; font-size: 16px; }
    .canvas se-graph-view { flex: 1; min-height: 0; }
    .legend { margin: 0; font-size: 11.5px; }
    aside { width: 320px; overflow: auto; border-left: 1px solid #e1e6eb; padding-left: 12px; }
    aside h4 { margin: 10px 0 4px; }
    .link { font-size: 12px; padding: 2px 0; word-break: break-all; }
    details { margin-top: 8px; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    td { padding: 3px 4px; border-top: 1px solid #eef1f4; vertical-align: top; word-break: break-word; }
    td:last-child { white-space: nowrap; }
    tr.deny td { color: #b3261e; }
    a { color: #1565c0; cursor: pointer; text-decoration: underline; }
    .pad { padding: 8px; margin: 0; }
  `],
})
export class SecurityTabComponent {
  readonly api = input.required<TwxApi>();
  readonly openEntity = output<EntityRequest>();

  protected readonly pickerKinds = PICKER_KINDS;
  protected readonly kindLabel = KIND_LABEL;
  protected readonly systemUser = SYSTEM_USER;
  protected readonly depths = [0, 1, 2, 3, 4, 6];
  protected readonly refKey = refKey;
  protected readonly kind = signal<SecurityKind>('Role');
  protected readonly filter = signal('');
  protected readonly selected = signal<SecurityRef | null>(null);
  protected readonly upDepth = signal(2);
  protected readonly downDepth = signal(2);
  protected readonly status = signal<'loading' | 'done' | 'denied' | 'error'>('loading');
  protected readonly error = signal('');
  protected readonly model = signal<SecurityModel | null>(null);

  protected readonly matchingNames = computed(() => {
    const needle = this.filter().trim().toLowerCase();
    const names = this.model()?.namesOf(this.kind()) ?? [];
    return needle ? names.filter((name) => name.toLowerCase().includes(needle)) : names;
  });
  protected readonly shownNames = computed(() => this.matchingNames().slice(0, MAX_LISTED));

  private readonly drawn = computed<{ links: SecurityLink[]; truncated: boolean }>(() => {
    const model = this.model();
    if (!model) return { links: [], truncated: false };
    const selected = this.selected();
    return selected ? model.neighbourhood(selected, this.upDepth(), this.downDepth()) : model.overview();
  });
  protected readonly truncated = computed(() => this.drawn().truncated);

  protected readonly graph = computed(() => {
    const selected = this.selected();
    const { links } = this.drawn();
    const model = this.model();
    if (!model) return EMPTY_GRAPH;
    const above = new Set(selected ? model.transitive(selected, 'up').map(refKey) : []);
    const below = new Set(selected ? model.transitive(selected, 'down').map(refKey) : []);
    const nodes = new Map<string, GraphNode>();
    const addNode = (ref: SecurityRef): void => {
      const key = refKey(ref);
      if (nodes.has(key)) return;
      const kind = selected && key === refKey(selected) ? 'root' : above.has(key) ? 'incoming' : below.has(key) ? 'outgoing' : ref.name === SYSTEM_USER && ref.kind === 'User' ? 'selected' : 'entity';
      const label = ref.kind === 'OrganizationalUnit' ? ref.name.slice(ref.name.indexOf(':') + 1) : ref.name;
      nodes.set(key, { id: key, label, sublabel: KIND_LABEL[ref.kind], kind, shape: ref.kind === 'Organization' || ref.kind === 'OrganizationalUnit' ? 'folder' : ref.kind === 'PermissionGroup' ? 'note' : 'stadium' });
    };
    if (selected) addNode(selected);
    const edges: GraphEdge[] = [];
    for (const link of links) {
      addNode(link.from);
      addNode(link.to);
      // Drawn as "contained in": the arrow leaves the member and points at what holds it (the model links container → member).
      edges.push({ from: refKey(link.to), to: refKey(link.from), kind: link.relation });
    }
    return layoutGraph([...nodes.values()], edges, 'LR');
  });

  protected readonly directUp = computed(() => { const selected = this.selected(); return selected ? this.model()?.direct(selected, 'up') ?? [] : []; });
  protected readonly directDown = computed(() => { const selected = this.selected(); return selected ? this.model()?.direct(selected, 'down') ?? [] : []; });
  protected readonly allUp = computed(() => { const selected = this.selected(); return selected ? this.model()?.transitive(selected, 'up') ?? [] : []; });
  protected readonly allDown = computed(() => { const selected = this.selected(); return selected ? this.model()?.transitive(selected, 'down') ?? [] : []; });
  protected readonly throughRoles = computed(() => {
    const selected = this.selected();
    return selected && selected.kind !== 'Role' ? this.model()?.throughRoles(selected) ?? [] : [];
  });
  protected readonly grants = computed<EntityPermissionRow[]>(() => { const selected = this.selected(); return selected ? this.model()?.entityPermissions(selected) ?? [] : []; });

  constructor() {
    // Inputs are set after construction; load when the API arrives (and again if it changes).
    effect(() => {
      this.api();
      untracked(() => void this.load());
    });
  }

  protected reload(): void {
    this.api().forgetEntities();
    void this.load();
  }

  protected select(ref: SecurityRef | null): void {
    this.selected.set(ref);
    if (ref && ref.kind !== this.kind()) { this.kind.set(ref.kind); this.filter.set(''); }
  }

  protected onNode(node: PlacedNode): void {
    this.select(parseRefKey(node.id));
  }

  protected openable(row: EntityPermissionRow): boolean {
    return row.entityName !== '*' && OPENABLE.has(collectionOfType(row.entityType));
  }

  protected openGrant(row: EntityPermissionRow): void {
    this.openEntity.emit({ name: row.entityName, collection: collectionOfType(row.entityType) });
  }

  private async load(): Promise<void> {
    this.status.set('loading');
    this.error.set('');
    try {
      const api = this.api();
      const [bodies, users] = await Promise.all([api.securityBodies(), api.list('Users').catch(() => [])]);
      if (!bodies) { this.model.set(null); this.status.set('denied'); return; }
      const model = new SecurityModel(bodies, users.map((row) => row.name));
      this.model.set(model);
      const selected = this.selected();
      if (selected && !model.has(selected)) this.selected.set(null);
      this.status.set('done');
    } catch (failure) {
      this.error.set(failure instanceof Error ? failure.message : String(failure));
      this.status.set('error');
    }
  }
}
