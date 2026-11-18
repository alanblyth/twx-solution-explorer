import { ChangeDetectionStrategy, Component, ElementRef, ViewEncapsulation, computed, effect, input, output, signal, viewChild } from '@angular/core';
import { colourOf, SHARED_STYLES } from './styles.ts';
import { edgePath } from './graph-layout.ts';
import type { PlacedEdge, PlacedGraph, PlacedNode } from './graph-layout.ts';

/** Pan and zoom SVG view of a laid-out graph. Click a node or an edge to select it. */
@Component({
  selector: 'se-graph-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.ShadowDom,
  template: `
    <div class="bar toolbar">
      <button (click)="zoomBy(1.25)" title="Zoom in">+</button>
      <button (click)="zoomBy(0.8)" title="Zoom out">−</button>
      <button (click)="fit()" title="Fit to window">Fit</button>
      <span class="muted">{{ graph().nodes.length }} nodes, {{ graph().edges.length }} links · drag to pan, wheel to zoom</span>
      <span class="spacer"></span>
      <button (click)="downloadSvg()" title="Save as SVG">Save SVG</button>
    </div>
    <div #frame class="frame" (wheel)="onWheel($event)" (pointerdown)="startPan($event)" (pointermove)="pan($event)" (pointerup)="endPan($event)" (pointercancel)="endPan($event)">
      <svg #svg [attr.width]="'100%'" [attr.height]="'100%'">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#6b7782"/></marker>
          <marker id="arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#b8860b"/></marker>
        </defs>
        <g [attr.transform]="transform()">
          @for (edge of graph().edges; track edgeId(edge)) {
            <g class="edge" [class.hot]="edgeId(edge) === selectedEdge()" (click)="onEdge(edge, $event)">
              <path class="hit" [attr.d]="path(edge)"/>
              <path class="line" [class.dashed]="edge.kind === 'declared'" [attr.d]="path(edge)" [attr.marker-end]="edgeId(edge) === selectedEdge() ? 'url(#arrow-hot)' : 'url(#arrow)'"/>
              @if (edge.label) {
                <text [attr.x]="edge.labelX" [attr.y]="edge.labelY" text-anchor="middle" dominant-baseline="middle" class="edge-label">{{ edge.label }}</text>
              }
            </g>
          }
          @for (node of graph().nodes; track node.id) {
            <g class="node" [class.chosen]="node.id === selectedNode()" [attr.transform]="'translate(' + (node.x - node.width / 2) + ',' + (node.y - node.height / 2) + ')'" (click)="onNode(node, $event)" (dblclick)="nodeOpened.emit(node)">
              <rect [attr.width]="node.width" [attr.height]="node.height" rx="6" [attr.fill]="fill(node)" [attr.stroke]="stroke(node)"/>
              <text [attr.x]="node.width / 2" [attr.y]="node.sublabel ? 19 : node.height / 2" text-anchor="middle" dominant-baseline="middle" class="title">{{ node.label }}</text>
              @if (node.sublabel) {
                <text [attr.x]="node.width / 2" y="34" text-anchor="middle" dominant-baseline="middle" class="sub">{{ node.sublabel }}</text>
              }
              <title>{{ node.label }}{{ node.sublabel ? ' · ' + node.sublabel : '' }}</title>
            </g>
          }
        </g>
      </svg>
    </div>
  `,
  styles: [SHARED_STYLES, `
    :host { display: flex; flex-direction: column; height: 100%; min-height: 240px; }
    .bar { padding: 4px 0 6px; }
    .frame { flex: 1; min-height: 200px; border: 1px solid #d5dce3; border-radius: 4px; background: #fafbfc; overflow: hidden; cursor: grab; touch-action: none; }
    .frame:active { cursor: grabbing; }
    svg { display: block; user-select: none; }
    .node { cursor: pointer; }
    .node rect { stroke-width: 1.4; }
    .node.chosen rect { stroke-width: 3; }
    .node .title { font-size: 12px; font-weight: 600; fill: #1f2933; pointer-events: none; }
    .node .sub { font-size: 10.5px; fill: #6b7782; pointer-events: none; }
    .edge .line { fill: none; stroke: #8794a1; stroke-width: 1.4; pointer-events: none; }
    .edge .line.dashed { stroke-dasharray: 6 4; }
    .edge .hit { fill: none; stroke: transparent; stroke-width: 12; cursor: pointer; }
    .edge.hot .line { stroke: #b8860b; stroke-width: 2.6; }
    .edge-label { font-size: 10.5px; fill: #44505c; paint-order: stroke; stroke: #fafbfc; stroke-width: 4px; pointer-events: none; }
  `],
})
export class GraphViewComponent {
  readonly graph = input.required<PlacedGraph>();
  readonly selectedNode = input<string | null>(null);
  readonly selectedEdge = input<string | null>(null);
  readonly nodeClicked = output<PlacedNode>();
  readonly nodeOpened = output<PlacedNode>();
  readonly edgeClicked = output<PlacedEdge>();

  private readonly frame = viewChild.required<ElementRef<HTMLDivElement>>('frame');
  private readonly svg = viewChild.required<ElementRef<SVGSVGElement>>('svg');
  private readonly scale = signal(1);
  private readonly offsetX = signal(0);
  private readonly offsetY = signal(0);
  protected readonly transform = computed(() => `translate(${this.offsetX()},${this.offsetY()}) scale(${this.scale()})`);
  private dragging: { x: number; y: number; moved: boolean } | null = null;
  private suppressClick = false;

  constructor() {
    effect(() => {
      this.graph();
      queueMicrotask(() => this.fit());
    });
  }

  protected edgeId(edge: PlacedEdge): string { return `${edge.from}->${edge.to}`; }
  protected path(edge: PlacedEdge): string { return edgePath(edge.points); }
  protected fill(node: PlacedNode): string { return colourOf(node.kind).fill; }
  protected stroke(node: PlacedNode): string { return colourOf(node.kind).stroke; }

  protected onNode(node: PlacedNode, event: Event): void {
    event.stopPropagation();
    if (!this.suppressClick) this.nodeClicked.emit(node);
  }

  protected onEdge(edge: PlacedEdge, event: Event): void {
    event.stopPropagation();
    if (!this.suppressClick) this.edgeClicked.emit(edge);
  }

  fit(): void {
    const frame = this.frame().nativeElement;
    const { width, height } = this.graph();
    if (!width || !height || !frame.clientWidth) return;
    const scale = Math.min(frame.clientWidth / width, frame.clientHeight / height, 1.2);
    this.scale.set(scale);
    this.offsetX.set((frame.clientWidth - width * scale) / 2);
    this.offsetY.set((frame.clientHeight - height * scale) / 2);
  }

  zoomBy(factor: number, centreX?: number, centreY?: number): void {
    const frame = this.frame().nativeElement;
    const x = centreX ?? frame.clientWidth / 2;
    const y = centreY ?? frame.clientHeight / 2;
    const next = Math.min(4, Math.max(0.1, this.scale() * factor));
    const ratio = next / this.scale();
    this.offsetX.set(x - (x - this.offsetX()) * ratio);
    this.offsetY.set(y - (y - this.offsetY()) * ratio);
    this.scale.set(next);
  }

  protected onWheel(event: WheelEvent): void {
    event.preventDefault();
    const box = this.frame().nativeElement.getBoundingClientRect();
    this.zoomBy(event.deltaY < 0 ? 1.1 : 0.9, event.clientX - box.left, event.clientY - box.top);
  }

  protected startPan(event: PointerEvent): void {
    this.dragging = { x: event.clientX, y: event.clientY, moved: false };
    this.suppressClick = false;
  }

  protected pan(event: PointerEvent): void {
    if (!this.dragging) return;
    const deltaX = event.clientX - this.dragging.x;
    const deltaY = event.clientY - this.dragging.y;
    if (!this.dragging.moved && Math.abs(deltaX) + Math.abs(deltaY) < 4) return;
    this.dragging.moved = true;
    this.offsetX.update((value) => value + deltaX);
    this.offsetY.update((value) => value + deltaY);
    this.dragging.x = event.clientX;
    this.dragging.y = event.clientY;
  }

  protected endPan(_event: PointerEvent): void {
    this.suppressClick = this.dragging?.moved ?? false;
    this.dragging = null;
    setTimeout(() => (this.suppressClick = false));
  }

  downloadSvg(): void {
    const { width, height } = this.graph();
    const clone = this.svg().nativeElement.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));
    clone.querySelector('g[transform]')?.setAttribute('transform', 'translate(0,0)');
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = 'text{font-family:sans-serif} .title{font-size:12px;font-weight:600} .sub,.edge-label{font-size:10.5px} .line{fill:none;stroke:#8794a1;stroke-width:1.4} .hit{display:none}';
    clone.prepend(style);
    download('graph.svg', new XMLSerializer().serializeToString(clone), 'image/svg+xml');
  }
}

export function download(fileName: string, content: string, type: string): void {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
