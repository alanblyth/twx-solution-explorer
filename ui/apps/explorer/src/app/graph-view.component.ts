import { ChangeDetectionStrategy, Component, ElementRef, ViewEncapsulation, computed, effect, input, output, signal, viewChild } from '@angular/core';
import { colourOf, SHARED_STYLES } from './styles.ts';
import { edgePath } from './graph-layout.ts';
import type { PlacedEdge, PlacedGraph, PlacedNode } from './graph-layout.ts';
import { drawShape, SHAPE_LEGEND } from './node-shapes.ts';
import type { ShapeDrawing } from './node-shapes.ts';
import { perfUntilRendered } from './perf.ts';

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
      <button (click)="showLegend.set(!showLegend())" [class.primary]="showLegend()" title="What the shapes and lines mean">Legend</button>
      <button (click)="downloadSvg()" title="Save as SVG">Save SVG</button>
    </div>
    @if (showLegend()) {
      <div class="legend">
        @for (item of legend(); track item.shape) {
          <span class="legend-item"><svg width="34" height="20"><g transform="translate(1,1)">
            @for (part of item.drawing.behind; track $index) { <path [attr.d]="part" fill="#fff" stroke="#5b6b7b"/> }
            <path [attr.d]="item.drawing.outline" fill="#fff" stroke="#5b6b7b"/>
            @for (part of item.drawing.details; track $index) { <path [attr.d]="part" fill="none" stroke="#5b6b7b"/> }
          </g></svg>{{ item.label }}</span>
        }
        <span class="legend-item"><svg width="34" height="20"><path d="M2,10 H30" stroke="#8794a1" stroke-width="1.4" marker-end="url(#arrow)"/></svg>uses</span>
        <span class="legend-item"><svg width="34" height="20"><path d="M2,10 H30" class="calls-line" marker-end="url(#arrow-calls)"/></svg>calls (script)</span>
        <span class="legend-item"><svg width="34" height="20"><path d="M30,10 H4" stroke="#44505c" stroke-width="1.4" fill="none" marker-end="url(#inherit)"/></svg>inherits / implements</span>
        <span class="legend-item"><svg width="34" height="20"><path d="M2,10 H30" stroke="#8794a1" stroke-dasharray="6 4" fill="none" marker-end="url(#arrow)"/></svg>declared only</span>
      </div>
    }
    <div #frame class="frame" (wheel)="onWheel($event)" (pointerdown)="startPan($event)" (pointermove)="pan($event)" (pointerup)="endPan($event)" (pointercancel)="endPan($event)">
      <svg #svg [attr.width]="'100%'" [attr.height]="'100%'">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#6b7782"/></marker>
          <marker id="arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#b8860b"/></marker>
          <marker id="arrow-calls" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#1565c0"/></marker>
          <marker id="inherit" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M0,0 L12,6 L0,12 z" fill="#fff" stroke="#44505c"/></marker>
        </defs>
        <g [attr.transform]="transform()">
          @for (group of graph().groups; track group.id) {
            <g class="group" [class.inside]="group.kind === 'inside'">
              <rect [attr.x]="group.x - group.width / 2" [attr.y]="group.y - group.height / 2" [attr.width]="group.width" [attr.height]="group.height" rx="8"/>
              <text [attr.x]="group.x - group.width / 2 + 10" [attr.y]="group.y - group.height / 2 + 17" class="group-label">{{ group.label }}</text>
            </g>
          }
          @for (edge of graph().edges; track edgeId(edge)) {
            <g class="edge" [class.hot]="edgeId(edge) === selectedEdge() || edgeId(edge) === hoveredEdge()" (click)="onEdge(edge, $event)" (mouseenter)="hoverEdge(edge)" (mouseleave)="hoverEdge(null)">
              <path class="hit" [attr.d]="path(edge)"/>
              <path class="line" [class.dashed]="edge.kind === 'declared' || edge.kind === 'implements'" [class.calls]="edge.kind === 'calls'" [class.inherits]="isInheritance(edge)" [attr.d]="path(edge)"
                [attr.marker-end]="isInheritance(edge) ? null : edgeId(edge) === selectedEdge() || edgeId(edge) === hoveredEdge() ? 'url(#arrow-hot)' : edge.kind === 'calls' ? 'url(#arrow-calls)' : 'url(#arrow)'"
                [attr.marker-start]="isInheritance(edge) ? 'url(#inherit)' : null"/>
              @if (edge.label) {
                <text [attr.x]="edge.labelX" [attr.y]="edge.labelY" text-anchor="middle" dominant-baseline="middle" class="edge-label">{{ edge.label }}</text>
              }
            </g>
          }
          @for (node of graph().nodes; track node.id) {
            <g class="node" [class.chosen]="node.id === selectedNode()" [attr.transform]="'translate(' + (node.x - node.width / 2) + ',' + (node.y - node.height / 2) + ')'"
               (click)="onNode(node, $event)" (dblclick)="nodeOpened.emit(node)" (mouseenter)="nodeHovered.emit(node)" (mouseleave)="nodeHovered.emit(null)">
              @let drawing = shapeOf(node);
              @for (part of drawing.behind; track $index) { <path [attr.d]="part" [attr.fill]="fill(node)" [attr.stroke]="stroke(node)" class="outline"/> }
              <path [attr.d]="drawing.outline" [attr.fill]="fill(node)" [attr.stroke]="stroke(node)" class="outline"/>
              @for (part of drawing.details; track $index) { <path [attr.d]="part" fill="none" [attr.stroke]="stroke(node)" class="detail"/> }
              <text [attr.x]="node.width / 2" [attr.y]="(node.sublabel ? 19 : node.height / 2) + drawing.textOffsetY" text-anchor="middle" dominant-baseline="middle" class="title">{{ node.label }}</text>
              @if (node.sublabel) {
                <text [attr.x]="node.width / 2" [attr.y]="34 + drawing.textOffsetY" text-anchor="middle" dominant-baseline="middle" class="sub">{{ node.sublabel }}</text>
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
    .node .outline { stroke-width: 1.4; }
    .node .detail { stroke-width: 1.1; }
    .node.chosen .outline { stroke-width: 3; }
    .group rect { fill: rgba(91,107,123,.05); stroke: #b8c2cc; stroke-dasharray: 5 4; }
    .group.inside rect { fill: rgba(21,101,192,.06); stroke: #1565c0; stroke-dasharray: none; }
    .group-label { font-size: 12px; font-weight: 700; fill: #44505c; }
    .edge .line.calls, .calls-line { stroke: #1565c0; stroke-dasharray: 3 3; fill: none; stroke-width: 1.4; }
    .edge .line.inherits { stroke: #44505c; }
    .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 0 0 6px; font-size: 12px; color: #44505c; }
    .legend-item { display: inline-flex; align-items: center; gap: 4px; }
    .legend svg { overflow: visible; }
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
  /** The node or edge under the pointer, or null when it leaves. */
  readonly nodeHovered = output<PlacedNode | null>();
  readonly edgeHovered = output<PlacedEdge | null>();
  protected readonly hoveredEdge = signal<string | null>(null);
  protected readonly showLegend = signal(false);
  /** Shapes used in this graph, for the legend. */
  protected readonly legend = computed(() => {
    const used = new Set(this.graph().nodes.map((node) => node.shape ?? 'rounded'));
    return SHAPE_LEGEND.filter((item) => used.has(item.shape)).map((item) => ({ ...item, drawing: drawShape(item.shape, 32, 18) }));
  });
  private readonly shapeCache = new Map<string, ShapeDrawing>();

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
      const graph = this.graph();
      if (graph.nodes.length) perfUntilRendered('render', { nodes: graph.nodes.length, edges: graph.edges.length });
      queueMicrotask(() => this.fit());
    });
  }

  protected edgeId(edge: PlacedEdge): string { return `${edge.from}->${edge.to}`; }
  protected isInheritance(edge: PlacedEdge): boolean { return edge.kind === 'inherits' || edge.kind === 'implements'; }
  protected shapeOf(node: PlacedNode): ShapeDrawing {
    const key = `${node.shape ?? 'rounded'}:${node.width}:${node.height}`;
    let drawing = this.shapeCache.get(key);
    if (!drawing) {
      drawing = drawShape(node.shape ?? 'rounded', node.width, node.height);
      this.shapeCache.set(key, drawing);
    }
    return drawing;
  }
  protected hoverEdge(edge: PlacedEdge | null): void {
    this.hoveredEdge.set(edge ? this.edgeId(edge) : null);
    this.edgeHovered.emit(edge);
  }
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
    style.textContent = 'text{font-family:sans-serif} .title{font-size:12px;font-weight:600} .sub,.edge-label{font-size:10.5px} .line{fill:none;stroke:#8794a1;stroke-width:1.4} .line.calls{stroke:#1565c0;stroke-dasharray:3 3} .line.dashed{stroke-dasharray:6 4} .hit{display:none} .group rect{fill:none;stroke:#b8c2cc;stroke-dasharray:5 4} .group-label{font-size:12px;font-weight:700}';
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
