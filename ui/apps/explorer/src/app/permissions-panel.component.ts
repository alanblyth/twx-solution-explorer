import { ChangeDetectionStrategy, Component, ViewEncapsulation, computed, effect, input, model, output, signal, untracked } from '@angular/core';
import { SHARED_STYLES } from './styles.ts';
import { checkEntity, loadCheckContext, systemText } from './permission-check.ts';
import type { EntityPermissionReport, ServiceReport } from './permission-check.ts';
import { ISSUE_TEXT } from './permissions.ts';
import type { MemberEntity } from './extension-graph.ts';
import type { ServiceCaller } from './service-usage.ts';
import type { TwxApi } from './twx-api.ts';

/** Collapsible bar at the bottom of a tab: the permissions of the selected entity's services, with the two issues flagged. */
@Component({
  selector: 'se-permissions-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.ShadowDom,
  template: `
    <div class="panel" [class.open]="open()">
      <button class="bar" (click)="open.set(!open())" [attr.aria-expanded]="open()">
        <span class="chevron">{{ open() ? '▾' : '▸' }}</span>
        <b>Permissions</b>
        @if (entity(); as current) { <span class="muted">{{ current.name }}</span> }
        <span class="spacer"></span>
        @if (status() === 'loading') { <span class="muted">{{ progressText() }}</span> }
        @else if (report(); as current) {
          @if (issueCount()) { <span class="badge">⚠ {{ issueCount() }} issue{{ issueCount() === 1 ? '' : 's' }}</span> }
          @else if (current.readable) { <span class="ok">no issues</span> }
        } @else if (!open() && entity()) { <span class="muted">expand to check</span> }
      </button>
      @if (open()) {
        <div class="content">
          @if (!entity()) {
            <p class="muted">Select an entity to see who may run its services.</p>
          } @else if (status() === 'error') {
            <p class="warn error">{{ error() }}</p>
          } @else if (report(); as current) {
            @for (note of current.notes; track note) { <p class="muted note">{{ note }}</p> }
            @if (current.readable) {
              <div class="toolbar">
                <span>Visibility of {{ current.scope }}: System <b [class]="'sys-' + current.visibility.system">{{ systemText(current.visibility.system) }}</b>@if (current.visibility.others.length) {; others: {{ current.visibility.others.join('; ') }}}</span>
                <span class="spacer"></span>
                <label class="muted"><input type="checkbox" [checked]="showAll()" (change)="showAll.set(!showAll())"/> all services</label>
                <button (click)="reread()" title="Read permissions, scripts and mashups again">Re-read</button>
              </div>
              <table>
                <thead><tr><th>Service</th><th title="ServiceInvoke held by System">System</th><th>Others who may invoke</th><th>Called by services</th><th>Called from UI</th></tr></thead>
                <tbody>
                  @for (row of shownServices(); track row.service) {
                    <tr [class.issue]="row.issues.length">
                      <td><b>{{ row.service }}</b> <span class="pill">{{ row.origin }}</span></td>
                      <td [class]="'sys-' + row.invoke.system">{{ systemText(row.invoke.system) }}</td>
                      <td [title]="grantsText(row)">@for (who of row.invoke.others; track who) { <div>{{ who }}</div> } @empty { <span class="muted">nobody</span> }</td>
                      <td>@for (caller of row.callers; track $index) { <div><a (click)="openCaller(caller)">{{ caller.name }}.{{ caller.service }}</a></div> } @empty { <span class="muted">none found</span> }</td>
                      <td>@for (user of row.uiUsers; track user) { <div>{{ user }}</div> } @empty { <span class="muted">none found</span> }</td>
                    </tr>
                    @for (issue of row.issues; track issue) {
                      <tr class="issue-text"><td colspan="5">⚠ {{ row.service }}: {{ issueText[issue] }}</td></tr>
                    }
                  } @empty { <tr><td colspan="5" class="muted">{{ showAll() ? 'No services.' : 'No service is granted to anyone or called by anything. Tick "all services" to list them.' }}</td></tr> }
                </tbody>
              </table>
              <p class="muted note">Grants read from {{ current.sources.join(', ') }}. Callers are found in the scripts of every Thing, template and shape you can see; UI calls in mashup data sources and, by name, in extension widget JavaScript (an Angular bundle builds its URLs at run time).</p>
            }
          }
        </div>
      }
    </div>
  `,
  styles: [SHARED_STYLES, `
    :host { display: block; }
    .panel { border-top: 2px solid #d5dce3; background: #fafbfc; }
    .bar { width: 100%; display: flex; gap: 8px; align-items: center; border: 0; border-radius: 0; background: none; padding: 5px 6px; text-align: left; }
    .chevron { width: 12px; }
    .badge { background: #fff6e0; color: #8a5a00; border: 1px solid #f0d9a0; border-radius: 9px; padding: 0 8px; font-weight: 600; }
    .ok { color: #2e7d32; }
    .content { height: 260px; overflow: auto; padding: 4px 8px 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 6px; background: #fff; }
    th { text-align: left; font-weight: 600; color: #44505c; border-bottom: 1px solid #d5dce3; padding: 4px; position: sticky; top: 0; background: #fff; }
    td { padding: 4px; border-top: 1px solid #eef1f4; vertical-align: top; word-break: break-word; }
    tr.issue > td { background: #fff6e0; }
    tr.issue-text td { color: #8a5a00; background: #fffaf0; border-top: 0; font-size: 11.5px; }
    .sys-yes { color: #2e7d32; } .sys-no, .sys-denied { color: #b3261e; font-weight: 600; } .sys-unknown { color: #6b7782; }
    .note { margin: 4px 0; font-size: 11.5px; }
    a { color: #1565c0; cursor: pointer; text-decoration: underline; }
  `],
})
export class PermissionsPanelComponent {
  readonly api = input.required<TwxApi>();
  readonly entity = input<MemberEntity | null>(null);
  readonly open = model(false);
  readonly openEntity = output<MemberEntity>();

  protected readonly status = signal<'idle' | 'loading' | 'done' | 'error'>('idle');
  protected readonly error = signal('');
  protected readonly progress = signal({ done: 0, total: 0 });
  protected readonly report = signal<EntityPermissionReport | null>(null);
  protected readonly showAll = signal(false);
  protected readonly issueText = ISSUE_TEXT;
  protected readonly systemText = systemText;
  private ticket = 0;
  private loading: MemberEntity | null = null;

  protected readonly issueCount = computed(() => (this.report()?.services ?? []).reduce((count, row) => count + row.issues.length, 0));
  protected readonly shownServices = computed<ServiceReport[]>(() => {
    const rows = this.report()?.services ?? [];
    return this.showAll() ? rows : rows.filter((row) => row.issues.length || row.invoke.grants.length || row.callers.length || row.uiUsers.length);
  });
  protected readonly progressText = computed(() => {
    const { done, total } = this.progress();
    return total ? `reading scripts for callers ${done} / ${total}` : 'checking…';
  });

  constructor() {
    effect(() => {
      const entity = this.entity();
      const open = this.open();
      untracked(() => {
        const current = this.report()?.entity;
        if (!entity) { this.ticket += 1; this.report.set(null); this.status.set('idle'); return; }
        if (current && current.name === entity.name && current.type === entity.type) return;
        const pending = this.loading;
        if (this.status() === 'loading' && pending && pending.name === entity.name && pending.type === entity.type) return;
        this.report.set(null);
        if (open) void this.load(entity);
      });
    });
  }

  /** Every grant of the service and where it was read, for the tooltip. */
  protected grantsText(row: ServiceReport): string {
    return row.invoke.grants.map((grant) => `${grant.permitted ? '' : 'DENY '}${grant.type} ${grant.name} — ${grant.source}`).join('\n') || 'No ServiceInvoke grants';
  }

  protected reread(): void {
    const entity = this.entity();
    if (!entity) return;
    this.api().forgetEntities();
    this.report.set(null);
    void this.load(entity);
  }

  protected openCaller(caller: ServiceCaller): void {
    this.openEntity.emit({ name: caller.name, type: caller.collection.replace(/s$/, '') });
  }

  private async load(entity: MemberEntity): Promise<void> {
    const ticket = ++this.ticket;
    this.loading = entity;
    this.status.set('loading');
    this.error.set('');
    this.progress.set({ done: 0, total: 0 });
    try {
      const context = await loadCheckContext(this.api(), (done, total) => { if (ticket === this.ticket) this.progress.set({ done, total }); });
      const report = await checkEntity(this.api(), entity, context);
      if (ticket !== this.ticket) return;
      this.report.set(report);
      this.status.set('done');
    } catch (failure) {
      if (ticket !== this.ticket) return;
      this.error.set(failure instanceof Error ? failure.message : String(failure));
      this.status.set('error');
    }
  }
}
