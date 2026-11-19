import { ChangeDetectionStrategy, Component, ViewEncapsulation, computed, effect, input, linkedSignal, output, signal } from '@angular/core';
import { SHARED_STYLES } from './styles.ts';
import { ExtensionsTabComponent } from './extensions-tab.component.ts';
import { EntitiesTabComponent } from './entities-tab.component.ts';
import { ContainersTabComponent } from './containers-tab.component.ts';
import type { ContainerKind, ContainerRequest, EntityRequest } from './containers-tab.component.ts';
import { TwxApi } from './twx-api.ts';
import { startTabOf } from './start-tab.ts';
import type { Tab } from './start-tab.ts';

/** The Solution Explorer: one element, three tabs. Used as <se-explorer> by the ThingWorx widget. */
@Component({
  selector: 'se-explorer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.ShadowDom,
  imports: [ExtensionsTabComponent, ContainersTabComponent, EntitiesTabComponent],
  template: `
    <div class="shell">
      <nav class="tabs">
        <button [class.active]="tab() === 'extensions'" (click)="tab.set('extensions')">Extensions</button>
        <button [class.active]="tab() === 'containers'" (click)="tab.set('containers')">Projects &amp; Extensions</button>
        <button [class.active]="tab() === 'entities'" (click)="tab.set('entities')">Entities</button>
      </nav>
      <div class="panel" [hidden]="tab() !== 'extensions'">
        @if (opened().has('extensions')) { <se-extensions-tab [api]="api()" (extensionSelected)="extensionSelected.emit($event)" (showContents)="showContainer('Extension', $event)"/> }
      </div>
      <div class="panel" [hidden]="tab() !== 'containers'">
        @if (opened().has('containers')) { <se-containers-tab [api]="api()" [request]="containerRequest()" (openEntity)="showEntity($event)" (containerSelected)="containerSelected.emit($event)"/> }
      </div>
      <div class="panel" [hidden]="tab() !== 'entities'">
        <se-entities-tab [api]="api()" [requestedEntity]="requestedEntity()" [requestedCollection]="requestedCollection()" [requestedService]="service()" [requestedView]="view()" (entitySelected)="entitySelected.emit($event)" (serviceSelected)="serviceSelected.emit($event)"/>
      </div>
    </div>
  `,
  styles: [SHARED_STYLES, `
    :host { height: 100%; width: 100%; background: #fff; }
    .shell { display: flex; flex-direction: column; height: 100%; padding: 2px 4px; }
    .tabs { display: flex; gap: 2px; border-bottom: 2px solid #d5dce3; }
    .tabs button { border: 0; border-bottom: 3px solid transparent; border-radius: 0; background: none; padding: 8px 18px; font-weight: 600; color: #44505c; margin-bottom: -2px; }
    .tabs button.active { color: #1565c0; border-bottom-color: #1565c0; }
    .panel { flex: 1; min-height: 0; } .panel[hidden] { display: none; }
  `],
})
export class ExplorerComponent {
  readonly baseUrl = input('/Thingworx');
  readonly appKey = input('');
  /** Which tab opens first: "extensions", "containers" (Projects & Extensions) or "entities". */
  readonly startTab = input<Tab>('extensions');
  readonly entity = input('');
  readonly entityCollection = input('Things');
  readonly service = input('');
  readonly view = input<'graph' | 'sequence'>('graph');
  /** Project or extension to open on the Projects & Extensions tab, and which of the two it is ("Project" or "Extension"). */
  readonly container = input('');
  readonly containerKind = input<string>('Project');
  readonly entitySelected = output<string>();
  readonly serviceSelected = output<string>();
  readonly extensionSelected = output<string>();
  readonly containerSelected = output<string>();

  /**
   * The tab shown: StartTab until the user picks another. It follows the input directly, so the first tab created is the
   * start tab; a tab that started as 'extensions' and changed later created the Extensions tab, and ran its scan, on
   * every page load whatever StartTab said.
   */
  protected readonly tab = linkedSignal<Tab>(() => startTabOf(this.startTab()));
  protected readonly api = computed(() => new TwxApi({ baseUrl: this.baseUrl(), appKey: this.appKey() }));
  /** Scans are expensive: a tab is created when it is first shown, and kept. */
  protected readonly opened = signal(new Set<Tab>());
  /** The entity the Entities tab shows: from the widget inputs, then from "Open in Entities tab". */
  protected readonly requestedEntity = linkedSignal(() => this.entity());
  protected readonly requestedCollection = linkedSignal(() => this.entityCollection());
  /** The project or extension the Projects & Extensions tab shows: from the widget inputs, then from other tabs. */
  protected readonly containerRequest = linkedSignal<ContainerRequest | null>(() =>
    this.container() ? { kind: toContainerKind(this.containerKind()), name: this.container() } : null);

  constructor() {
    effect(() => {
      const tab = this.tab();
      if (!this.opened().has(tab)) this.opened.update((tabs) => new Set(tabs).add(tab));
    });
  }

  protected showEntity(request: EntityRequest): void {
    this.tab.set('entities');
    if (request.name === this.requestedEntity() && request.collection === this.requestedCollection()) {
      // The same entity again (the user may have moved on in that tab): clear it first so the tab sees a change.
      this.requestedEntity.set('');
      setTimeout(() => this.requestedEntity.set(request.name));
      return;
    }
    this.requestedCollection.set(request.collection);
    this.requestedEntity.set(request.name);
  }

  protected showContainer(kind: ContainerKind, name: string): void {
    this.tab.set('containers');
    this.containerRequest.set({ kind, name });
  }
}

function toContainerKind(value: string): ContainerKind {
  return /^ext/i.test(value) ? 'Extension' : 'Project';
}
