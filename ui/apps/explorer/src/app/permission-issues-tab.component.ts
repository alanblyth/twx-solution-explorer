import { ChangeDetectionStrategy, Component, ViewEncapsulation, computed, effect, input, output, signal, untracked } from '@angular/core';
import { SHARED_STYLES } from './styles.ts';
import { checkEntity, loadCheckContext } from './permission-check.ts';
import { ISSUE_TEXT } from './permissions.ts';
import type { PermissionIssue } from './permissions.ts';
import { containerMembersFor } from './container-members.ts';
import type { ContainerKind } from './container-members.ts';
import { collectionOfType } from './models.ts';
import { mapWithLimit } from './twx-api.ts';
import type { TwxApi } from './twx-api.ts';
import type { MemberEntity } from './extension-graph.ts';
import type { EntityRequest } from './containers-tab.component.ts';

type Scope = ContainerKind | 'All';

/** One service with an issue. */
interface IssueRow { entity: MemberEntity; service: string; issue: PermissionIssue; detail: string }

const CHECKED_TYPES = new Set(['Thing', 'ThingTemplate', 'ThingShape']);
const ISSUE_LABEL: Record<PermissionIssue, string> = { 'system-missing': 'System lacks access', 'users-not-ui': 'Users granted, no UI calls it' };
const MAX_OPTIONS = 300;

/** The Permission Issues tab: finds services in a project, an extension or the whole platform that meet either issue. */
@Component({
  selector: 'se-permission-issues-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.ShadowDom,
  template: `
    <div class="toolbar head">
      <select [value]="scope()" (change)="setScope($any($event.target).value)">
        <option value="Project">Project</option>
        <option value="Extension">Extension</option>
        <option value="All">Every Thing, template and shape</option>
      </select>
      @if (scope() !== 'All') {
        <input class="filter" placeholder="Filter {{ scope() === 'Project' ? 'projects' : 'extensions' }}" [value]="optionFilter()" (input)="optionFilter.set($any($event.target).value)"/>
      }
      <input class="filter" placeholder="Entity name contains" [value]="nameFilter()" (input)="nameFilter.set($any($event.target).value)"/>
      <label title="{{ issueText['system-missing'] }}"><input type="checkbox" [checked]="findSystemMissing()" (change)="findSystemMissing.set(!findSystemMissing())"/> System lacks access to a called service</label>
      <label title="{{ issueText['users-not-ui'] }}"><input type="checkbox" [checked]="findUsersNotUi()" (change)="findUsersNotUi.set(!findUsersNotUi())"/> Users granted, no UI calls it</label>
      <label title="Built-in platform services such as GetNamedProperties, which the platform grants to ComposerUsers by default"><input type="checkbox" [checked]="includeBuiltin()" (change)="includeBuiltin.set(!includeBuiltin())"/> include built-in services</label>
      <button class="primary" (click)="search()" [disabled]="searching() || (scope() !== 'All' && !chosen()) || (!findSystemMissing() && !findUsersNotUi())">Search</button>
      @if (searching()) {
        <button (click)="cancel()">Cancel</button>
        <progress [max]="progress().total || 1" [value]="progress().done"></progress>
        <span class="muted">{{ progress().phase }} {{ progress().done }} / {{ progress().total }}</span>
      }
    </div>
    @if (error()) { <p class="warn error">{{ error() }}</p> }
    <div class="body">
      @if (scope() !== 'All') {
        <div class="chooser">
          @for (name of filteredOptions(); track name) {
            <div class="option" [class.chosen]="name === chosen()" (click)="chosen.set(name)" (dblclick)="chosen.set(name); search()">{{ name }}</div>
          } @empty { <p class="muted">{{ optionsLoading() ? 'Loading…' : 'No match.' }}</p> }
          @if (optionCount() > filteredOptions().length) { <p class="muted">{{ optionCount() - filteredOptions().length }} more; filter to narrow.</p> }
        </div>
      }
      <div class="results">
        @if (searched(); as summary) {
          <div class="toolbar">
            <b>{{ rows().length }} issue{{ rows().length === 1 ? '' : 's' }}</b>
            <span class="muted">in {{ summary.checked }} entit{{ summary.checked === 1 ? 'y' : 'ies' }} of {{ summary.scope }}</span>
            <span class="spacer"></span>
            <input placeholder="Filter results" [value]="resultFilter()" (input)="resultFilter.set($any($event.target).value)"/>
          </div>
          @for (note of summary.notes; track note) { <p class="muted note">{{ note }}</p> }
          <table>
            <thead><tr><th>Entity</th><th>Service</th><th>Issue</th><th>Details</th></tr></thead>
            <tbody>
              @for (row of shownRows(); track $index) {
                <tr (click)="open(row)" title="Open in the Entities tab">
                  <td><a>{{ row.entity.name }}</a> <span class="pill">{{ row.entity.type }}</span></td>
                  <td><b>{{ row.service }}</b></td>
                  <td [title]="issueText[row.issue]"><span class="issue">⚠ {{ issueLabel[row.issue] }}</span></td>
                  <td>{{ row.detail }}</td>
                </tr>
              } @empty { <tr><td colspan="4" class="muted">No service meets the chosen criteria.</td></tr> }
            </tbody>
          </table>
        } @else {
          <p class="muted pad">
            Pick a project, an extension or every entity, choose the issues to look for, and press Search.
            <br>• <b>System lacks access</b>: {{ issueText['system-missing'] }}
            <br>• <b>Users granted, no UI calls it</b>: {{ issueText['users-not-ui'] }}
          </p>
        }
      </div>
    </div>
  `,
  styles: [SHARED_STYLES, `
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .head { padding: 8px 0; }
    .filter { width: 180px; }
    .body { display: flex; gap: 12px; flex: 1; min-height: 0; }
    .chooser { width: 220px; overflow: auto; border-right: 1px solid #e1e6eb; padding-right: 8px; }
    .option { padding: 3px 6px; border-radius: 4px; cursor: pointer; word-break: break-all; }
    .option:hover { background: #eef2f6; } .option.chosen { background: #d6e8fb; font-weight: 600; }
    .results { flex: 1; min-width: 0; overflow: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 6px; }
    th { text-align: left; font-weight: 600; color: #44505c; border-bottom: 1px solid #d5dce3; padding: 4px; position: sticky; top: 0; background: #fff; }
    td { padding: 4px; border-top: 1px solid #eef1f4; vertical-align: top; word-break: break-word; }
    tbody tr { cursor: pointer; } tbody tr:hover { background: #f3f7fb; }
    .issue { color: #8a5a00; background: #fff6e0; border: 1px solid #f0d9a0; border-radius: 9px; padding: 0 6px; white-space: nowrap; }
    a { color: #1565c0; text-decoration: underline; }
    .note { margin: 4px 0; font-size: 11.5px; }
    .pad { padding: 12px 0; line-height: 1.7; }
    progress { width: 140px; }
  `],
})
export class PermissionIssuesTabComponent {
  readonly api = input.required<TwxApi>();
  readonly openEntity = output<EntityRequest>();

  protected readonly scope = signal<Scope>('Project');
  protected readonly optionFilter = signal('');
  protected readonly nameFilter = signal('');
  protected readonly chosen = signal<string | null>(null);
  protected readonly findSystemMissing = signal(true);
  protected readonly findUsersNotUi = signal(true);
  protected readonly includeBuiltin = signal(false);
  protected readonly searching = signal(false);
  protected readonly progress = signal({ phase: '', done: 0, total: 0 });
  protected readonly error = signal('');
  protected readonly rows = signal<IssueRow[]>([]);
  protected readonly searched = signal<{ scope: string; checked: number; notes: string[] } | null>(null);
  protected readonly resultFilter = signal('');
  protected readonly optionsLoading = signal(false);
  protected readonly issueText = ISSUE_TEXT;
  protected readonly issueLabel = ISSUE_LABEL;
  private readonly names = signal<Record<string, string[]>>({});
  private cancelled = false;
  private ticket = 0;

  private readonly matchingOptions = computed(() => {
    const needle = this.optionFilter().trim().toLowerCase();
    const options = this.names()[this.scope()] ?? [];
    return needle ? options.filter((name) => name.toLowerCase().includes(needle)) : options;
  });
  protected readonly optionCount = computed(() => this.matchingOptions().length);
  protected readonly filteredOptions = computed(() => this.matchingOptions().slice(0, MAX_OPTIONS));
  protected readonly shownRows = computed(() => {
    const needle = this.resultFilter().trim().toLowerCase();
    if (!needle) return this.rows();
    return this.rows().filter((row) => `${row.entity.name} ${row.service} ${ISSUE_LABEL[row.issue]} ${row.detail}`.toLowerCase().includes(needle));
  });

  constructor() {
    effect(() => {
      const scope = this.scope();
      if (scope !== 'All') untracked(() => void this.loadNames(scope));
    });
  }

  protected setScope(scope: Scope): void {
    this.scope.set(scope);
    this.chosen.set(null);
    this.optionFilter.set('');
  }

  protected cancel(): void { this.cancelled = true; }

  protected open(row: IssueRow): void {
    this.openEntity.emit({ name: row.entity.name, collection: collectionOfType(row.entity.type) });
  }

  private async loadNames(kind: ContainerKind): Promise<void> {
    if (this.names()[kind]) return;
    this.optionsLoading.set(true);
    try {
      const list = await containerMembersFor(this.api()).names(kind);
      this.names.update((known) => ({ ...known, [kind]: list }));
    } catch (failure) {
      this.error.set(failure instanceof Error ? failure.message : String(failure));
    } finally {
      this.optionsLoading.set(false);
    }
  }

  protected async search(): Promise<void> {
    const scope = this.scope();
    const name = this.chosen();
    if (scope !== 'All' && !name) return;
    const ticket = ++this.ticket;
    const stale = (): boolean => this.cancelled || ticket !== this.ticket;
    const wanted = new Set<PermissionIssue>([
      ...(this.findSystemMissing() ? ['system-missing' as const] : []), ...(this.findUsersNotUi() ? ['users-not-ui' as const] : []),
    ]);
    const nameNeedle = this.nameFilter().trim().toLowerCase();
    const includeBuiltin = this.includeBuiltin();
    this.cancelled = false;
    this.searching.set(true);
    this.error.set('');
    this.rows.set([]);
    this.searched.set(null);
    try {
      const api = this.api();
      this.progress.set({ phase: 'Listing entities', done: 0, total: 0 });
      let members: MemberEntity[];
      if (scope === 'All') {
        const collections: [string, string][] = [['Things', 'Thing'], ['ThingTemplates', 'ThingTemplate'], ['ThingShapes', 'ThingShape']];
        const lists = await Promise.all(collections.map(([collection]) => api.list(collection).catch(() => [])));
        members = lists.flatMap((rows, position) => rows.map((row) => ({ name: row.name, type: collections[position][1] })));
      } else {
        members = await containerMembersFor(api).members(scope, name as string, true);
      }
      members = members.filter((member) => CHECKED_TYPES.has(member.type) && (!nameNeedle || member.name.toLowerCase().includes(nameNeedle)));
      if (stale()) return this.stopped(ticket);

      const context = await loadCheckContext(api, (done, total) => { if (!stale()) this.progress.set({ phase: 'Reading scripts for callers', done, total }); });
      this.progress.set({ phase: 'Reading uses in mashups and widgets', done: 0, total: 0 });
      if (stale()) return this.stopped(ticket);

      const found: IssueRow[] = [];
      const notes = new Set<string>();
      let done = 0;
      this.progress.set({ phase: 'Checking', done, total: members.length });
      await mapWithLimit(members, 6, async (member) => {
        const report = await checkEntity(api, member, context);
        for (const note of report.notes) if (!note.startsWith('A shape holds')) notes.add(note);
        for (const service of report.services) {
          if (service.origin === 'builtin' && !includeBuiltin) continue;
          for (const issue of service.issues) {
            if (!wanted.has(issue)) continue;
            const detail = issue === 'system-missing'
              ? `Called by ${service.callers.map((caller) => `${caller.name}.${caller.service}`).join(', ')}. System: invoke ${service.invoke.system}, visibility ${report.visibility.system}.`
              : `Granted to ${service.invoke.others.join('; ')}.`;
            found.push({ entity: member, service: service.service, issue, detail });
          }
        }
        this.progress.update((value) => ({ ...value, done: ++done }));
      }, stale);
      if (stale()) return this.stopped(ticket);
      found.sort((left, right) => left.entity.name.localeCompare(right.entity.name) || left.service.localeCompare(right.service) || left.issue.localeCompare(right.issue));
      if (context.calls.unreadable) notes.add(`${context.calls.unreadable} Thing(s), template(s) or shape(s) could not be read, so their calls are not counted.`);
      this.rows.set(found);
      this.searched.set({ scope: scope === 'All' ? 'the platform' : `${scope} ${name}`, checked: members.length, notes: [...notes] });
    } catch (failure) {
      if (ticket === this.ticket) this.error.set(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (ticket === this.ticket) this.searching.set(false);
    }
  }

  private stopped(ticket: number): void {
    if (ticket === this.ticket) this.searching.set(false);
  }
}
