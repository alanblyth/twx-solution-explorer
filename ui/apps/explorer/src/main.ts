import { createApplication } from '@angular/platform-browser';
import { provideZonelessChangeDetection } from '@angular/core';
import { createCustomElement } from '@angular/elements';
import { ExplorerComponent } from './app/explorer.component.ts';

const VERSION = '0.1.0';

// One bundle registers the Solution Explorer element once. Zoneless: no zone.js, so nothing on the host ThingWorx page is patched.
(async () => {
  const host = window as unknown as Record<string, unknown>;
  if (host['__seElementsVersion'] || host['__seElementsStarting']) return; // loaded twice: the first wins
  host['__seElementsStarting'] = true;
  const app = await createApplication({ providers: [provideZonelessChangeDetection()] });
  if (!customElements.get('se-explorer')) customElements.define('se-explorer', createCustomElement(ExplorerComponent, { injector: app.injector }));
  host['__seElementsVersion'] = VERSION;
})();
