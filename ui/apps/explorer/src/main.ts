import { createApplication } from '@angular/platform-browser';
import { provideZonelessChangeDetection } from '@angular/core';
import { createCustomElement } from '@angular/elements';
import { ExplorerComponent } from './app/explorer.component.ts';
import { layoutGraph } from './app/graph-layout.ts';
import { perfClear, perfEnabled, perfEntries } from './app/perf.ts';
import { syntheticGraph } from './app/perf-graph.ts';

const VERSION = '0.1.0';

// One bundle registers the Solution Explorer element once. Zoneless: no zone.js, so nothing on the host ThingWorx page is patched.
(async () => {
  const host = window as unknown as Record<string, unknown>;
  if (host['__seElementsVersion'] || host['__seElementsStarting']) return; // loaded twice: the first wins
  host['__seElementsStarting'] = true;
  const app = await createApplication({ providers: [provideZonelessChangeDetection()] });
  if (!customElements.get('se-explorer')) customElements.define('se-explorer', createCustomElement(ExplorerComponent, { injector: app.injector }));
  host['__seElementsVersion'] = VERSION;
  if (perfEnabled()) {
    // Debug hook (se-perf=1): read the measures, and time dagre on a synthetic graph of a given size on this page.
    host['__sePerf'] = {
      entries: perfEntries,
      clear: perfClear,
      layout: (count: number, grouped = true): { nodes: number; edges: number; milliseconds: number } => {
        const graph = syntheticGraph(count);
        const started = performance.now();
        const placed = layoutGraph(graph.nodes, graph.edges, 'LR', grouped ? graph.groups : []);
        return { nodes: placed.nodes.length, edges: placed.edges.length, milliseconds: Math.round(performance.now() - started) };
      },
    };
  }
})();
