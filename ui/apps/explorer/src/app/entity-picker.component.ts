import { ChangeDetectionStrategy, Component, ViewEncapsulation, computed, effect, input, model, output, signal, untracked } from '@angular/core';
import { SHARED_STYLES } from './styles.ts';
import { containerMembersFor, memberNamesIn } from './container-members.ts';
import type { ContainerKind } from './container-members.ts';
import type { EntityRow } from './models.ts';
import type { TwxApi } from './twx-api.ts';

export const PICKER_COLLECTIONS = ['Things', 'ThingTemplates', 'ThingShapes', 'DataShapes', 'Mashups', 'Projects'];
const MAX_RESULTS = 500;

type ScopeKind = 'none' | ContainerKind;

/** The Entities tab's list: pick a collection, filter by name and, optionally, by the project or extension that holds the entity. */
@Component({
  selector: 'se-entity-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.ShadowDom,
  template: `
    <div class="toolbar">
      <select (change)="collection.set($any($event.target).value)">
        @for (item of collections; track item) { <option [value]="item" [selected]="item === collection()">{{ item }}</option> }
      </select>
      <input type="search" placeholder="Filter by name" [value]="query()" (input)="query.set($any($event.target).value)"/>
    </div>
    <div class="toolbar">
      <select class="scope-kind" title="Show only the entities of one project or extension" (change)="setScopeKind($any($event.target).value)">
        <option value="none" [selected]="scopeKind() === 'none'">All entities</option>
        <option value="Project" [selected]="scopeKind() === 'Project'">In project</option>
        <option value="Extension" [selected]="scopeKind() === 'Extension'">In extension</option>
      </select>
      @if (scopeKind() !== 'none') {
        <select class="scope-name" (change)="scopeName.set($any($event.target).value)">
          <option value="" [selected]="!scopeName()">{{ scopeNames().length ? 'Choose…' : 'Loading…' }}</option>
          @for (name of scopeNames(); track name) { <option [value]="name" [selected]="name === scopeName()">{{ name }}</option> }
        </select>
      }
    </div>
    <div class="results">
      @for (row of results(); track row.name) {
        <div class="row" [class.on]="row.name === selected()?.name && row.collection === selected()?.collection" (click)="picked.emit(row)" [title]="row.description">
          <span class="name">{{ row.name }}</span>
          <span class="muted desc">{{ row.description }}</span>
        </div>
      } @empty {
        <p class="muted">{{ searching() ? 'Searching…' : scopeError() || 'No matches.' }}</p>
      }
    </div>
  `,
  styles: [SHARED_STYLES, `
    :host { display: flex; flex-direction: column; min-height: 0; gap: 6px; }
    .toolbar select { max-width: 110px; } .toolbar input { flex: 1; min-width: 0; }
    .toolbar .scope-name { flex: 1; min-width: 0; max-width: none; }
    .results { flex: 1; overflow: auto; border: 1px solid #d5dce3; border-radius: 4px; background: #fff; min-height: 0; }
    .row { display: flex; gap: 6px; align-items: baseline; padding: 4px 8px; cursor: pointer; border-bottom: 1px solid #f0f3f6; }
    .row:hover { background: #f3f7fb; } .row.on { background: #d6e8fb; }
    .row .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .row .desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; font-size: 11.5px; }
    p { padding: 4px 8px; margin: 0; }
  `],
})
export class EntityPickerComponent {
  readonly api = input.required<TwxApi>();
  readonly selected = input<{ name: string; collection: string } | null>(null);
  /** Two-way: the owner may switch the collection when it opens an entity of another kind. */
  readonly collection = model('Things');
  readonly picked = output<EntityRow>();

  protected readonly collections = PICKER_COLLECTIONS;
  protected readonly query = signal('');
  protected readonly scopeKind = signal<ScopeKind>('none');
  protected readonly scopeName = signal('');
  protected readonly scopeNames = signal<string[]>([]);
  protected readonly scopeError = signal('');
  protected readonly results = signal<EntityRow[]>([]);
  protected readonly searching = signal(false);
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private searchCounter = 0;

  private readonly scope = computed(() => (this.scopeKind() !== 'none' && this.scopeName() ? { kind: this.scopeKind() as ContainerKind, name: this.scopeName() } : null));

  constructor() {
    effect(() => {
      const collection = this.collection();
      const text = this.query();
      const scope = this.scope();
      untracked(() => this.scheduleSearch(collection, text, scope));
    });
  }

  protected async setScopeKind(kind: ScopeKind): Promise<void> {
    this.scopeKind.set(kind);
    this.scopeName.set('');
    this.scopeNames.set([]);
    this.scopeError.set('');
    if (kind === 'none') return;
    try {
      const names = await containerMembersFor(this.api()).names(kind);
      if (this.scopeKind() === kind) this.scopeNames.set(names);
    } catch (failure) {
      this.scopeError.set(`Could not list ${kind === 'Project' ? 'projects' : 'extensions'}: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
  }

  private scheduleSearch(collection: string, text: string, scope: { kind: ContainerKind; name: string } | null): void {
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(async () => {
      const ticket = ++this.searchCounter;
      this.searching.set(true);
      this.scopeError.set('');
      try {
        const [rows, members] = await Promise.all([
          this.api().list(collection),
          scope ? containerMembersFor(this.api()).members(scope.kind, scope.name) : Promise.resolve(null),
        ]);
        const inScope = members ? memberNamesIn(members, collection) : null;
        const needle = text.trim().toLowerCase();
        const matches = rows.filter((row) => (!inScope || inScope.has(row.name))
          && (!needle || row.name.toLowerCase().includes(needle) || row.description.toLowerCase().includes(needle)));
        if (ticket === this.searchCounter) this.results.set(matches.slice(0, MAX_RESULTS));
      } catch (failure) {
        if (ticket !== this.searchCounter) return;
        this.results.set([]);
        if (scope) this.scopeError.set(`Could not read ${scope.kind.toLowerCase()} ${scope.name}: ${failure instanceof Error ? failure.message : String(failure)}`);
      } finally {
        if (ticket === this.searchCounter) this.searching.set(false);
      }
    }, 150);
  }
}
