import { ChangeDetectionStrategy, Component, ViewEncapsulation, computed, input, output, signal } from '@angular/core';
import { SHARED_STYLES } from './styles.ts';
import { ExtensionsTabComponent } from './extensions-tab.component.ts';
import { EntitiesTabComponent } from './entities-tab.component.ts';
import { TwxApi } from './twx-api.ts';

/** The Solution Explorer: one element, two tabs. Used as <se-explorer> by the ThingWorx widget. */
@Component({
  selector: 'se-explorer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.ShadowDom,
  imports: [ExtensionsTabComponent, EntitiesTabComponent],
  template: `
    <div class="shell">
      <nav class="tabs">
        <button [class.active]="tab() === 'extensions'" (click)="tab.set('extensions')">Extensions</button>
        <button [class.active]="tab() === 'entities'" (click)="tab.set('entities')">Entities</button>
      </nav>
      <div class="panel" [hidden]="tab() !== 'extensions'">
        @if (extensionsOpened()) { <se-extensions-tab [api]="api()" (extensionSelected)="extensionSelected.emit($event)"/> }
      </div>
      <div class="panel" [hidden]="tab() !== 'entities'">
        <se-entities-tab [api]="api()" [requestedEntity]="entity()" [requestedCollection]="entityCollection()" [requestedService]="service()" [requestedView]="view()" (entitySelected)="entitySelected.emit($event)" (serviceSelected)="serviceSelected.emit($event)"/>
      </div>
    </div>
  `,
  styles: [SHARED_STYLES, `
    :host { height: 100%; width: 100%; background: #fff; }
    .shell { display: flex; flex-direction: column; height: 100%; padding: 8px 12px; }
    .tabs { display: flex; gap: 2px; border-bottom: 2px solid #d5dce3; }
    .tabs button { border: 0; border-bottom: 3px solid transparent; border-radius: 0; background: none; padding: 8px 18px; font-weight: 600; color: #44505c; margin-bottom: -2px; }
    .tabs button.active { color: #1565c0; border-bottom-color: #1565c0; }
    .panel { flex: 1; min-height: 0; } .panel[hidden] { display: none; }
  `],
})
export class ExplorerComponent {
  readonly baseUrl = input('/Thingworx');
  readonly appKey = input('');
  /** Which tab opens first: "extensions" or "entities". */
  readonly startTab = input<'extensions' | 'entities'>('extensions');
  readonly entity = input('');
  readonly entityCollection = input('Things');
  readonly service = input('');
  readonly view = input<'graph' | 'sequence'>('graph');
  readonly entitySelected = output<string>();
  readonly serviceSelected = output<string>();
  readonly extensionSelected = output<string>();

  protected readonly tab = signal<'extensions' | 'entities'>('extensions');
  protected readonly api = computed(() => new TwxApi({ baseUrl: this.baseUrl(), appKey: this.appKey() }));
  /** The extension scan is expensive: it starts only when its tab is first shown. */
  protected readonly extensionsOpened = computed(() => this.openedOnce() || this.tab() === 'extensions');
  private readonly openedOnce = signal(false);

  constructor() {
    queueMicrotask(() => this.tab.set(this.startTab()));
  }
}
