import { ChangeDetectionStrategy, Component, ViewEncapsulation, computed, input, output, signal, viewChild, ElementRef } from '@angular/core';
import { SHARED_STYLES, colourOf } from './styles.ts';
import { layoutSequence, toMermaid } from './sequence-layout.ts';
import type { Message } from './sequence-layout.ts';
import { download } from './graph-view.component.ts';
import type { CallTree } from './models.ts';

@Component({
  selector: 'se-sequence-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.ShadowDom,
  template: `
    <div class="toolbar bar">
      <button (click)="zoom.set(zoom() * 1.2)">+</button>
      <button (click)="zoom.set(zoom() / 1.2)">−</button>
      <button (click)="zoom.set(1)">100%</button>
      <span class="muted">{{ layout().messages.length ? layout().participants.length + ' participants' : 'Nothing is called' }}</span>
      <span class="spacer"></span>
      <button (click)="copyMermaid()">{{ copied() ? 'Copied' : 'Copy Mermaid' }}</button>
      <button (click)="saveSvg()">Save SVG</button>
    </div>
    <div class="frame">
      <svg #svg [attr.width]="layout().width * zoom()" [attr.height]="layout().height * zoom()" [attr.viewBox]="'0 0 ' + layout().width + ' ' + layout().height">
        <defs>
          <marker id="seq-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#44505c"/></marker>
        </defs>
        @for (frame of layout().frames; track $index) {
          <g class="fragment">
            <rect [attr.x]="frame.x1" [attr.y]="frame.y1" [attr.width]="frame.x2 - frame.x1" [attr.height]="frame.y2 - frame.y1" rx="3"/>
            <path class="tab" [attr.d]="'M' + frame.x1 + ',' + frame.y1 + ' h' + tabWidth(frame.kind) + ' v14 l-6,6 h-' + (tabWidth(frame.kind) - 6) + ' z'"/>
            <text [attr.x]="frame.x1 + 6" [attr.y]="frame.y1 + 14" class="kind">{{ frame.kind }}</text>
            <text [attr.x]="frame.x1 + tabWidth(frame.kind) + 8" [attr.y]="frame.y1 + 14" class="guard">[{{ frame.label }}]</text>
            @for (divider of frame.dividers; track $index) {
              <line [attr.x1]="frame.x1" [attr.x2]="frame.x2" [attr.y1]="divider.y" [attr.y2]="divider.y"/>
              <text [attr.x]="frame.x1 + 8" [attr.y]="divider.y + 13" class="guard">[{{ divider.label }}]</text>
            }
          </g>
        }
        @for (participant of layout().participants; track participant.id) {
          <line class="lifeline" [attr.x1]="participant.x" [attr.x2]="participant.x" [attr.y1]="layout().headerHeight" [attr.y2]="layout().height - 16"/>
          <g>
            <rect [attr.x]="participant.x - boxWidth(participant.label) / 2" y="6" [attr.width]="boxWidth(participant.label)" height="32" rx="5" [attr.fill]="fill(participant.kind, $first)" [attr.stroke]="stroke(participant.kind, $first)"/>
            <text [attr.x]="participant.x" y="22" text-anchor="middle" dominant-baseline="middle" class="participant">{{ participant.label }}</text>
          </g>
        }
        @for (activation of layout().activations; track $index) {
          <rect class="activation" [attr.x]="activation.x - 5 + activation.level * 6" [attr.y]="activation.y1" width="10" [attr.height]="activation.y2 - activation.y1"/>
        }
        @for (message of layout().messages; track $index) {
          <g class="msg" [class.hot]="$index === hoveredMessage()" (pointerenter)="hoverMessage($index, message)" (pointerleave)="hoverMessage(null, null)">
            @if (message.self) {
              <path class="hit" [attr.d]="'M' + (message.fromX + 6) + ',' + message.y + ' h28 v14 h-28'"/>
              <path class="message" [attr.d]="'M' + (message.fromX + 6) + ',' + message.y + ' h28 v14 h-28'" marker-end="url(#seq-arrow)" fill="none"/>
              <text [attr.x]="message.fromX + 40" [attr.y]="message.y + 4" class="label" [class.leaf]="message.kind !== 'script'">{{ message.label }}</text>
            } @else {
              <line class="hit" [attr.x1]="message.fromX" [attr.x2]="message.toX" [attr.y1]="message.y" [attr.y2]="message.y"/>
              <line class="message" [class.dashed]="message.dashed" [attr.x1]="message.fromX + side(message.fromX, message.toX)" [attr.x2]="message.toX - side(message.fromX, message.toX)" [attr.y1]="message.y" [attr.y2]="message.y" marker-end="url(#seq-arrow)"/>
              <text [attr.x]="(message.fromX + message.toX) / 2" [attr.y]="message.y - 6" text-anchor="middle" class="label" [class.leaf]="message.kind !== 'script'">{{ message.label }}</text>
            }
          </g>
        }
      </svg>
    </div>
  `,
  styles: [SHARED_STYLES, `
    :host { display: flex; flex-direction: column; height: 100%; min-height: 240px; }
    .bar { padding: 4px 0 6px; }
    .frame { flex: 1; overflow: auto; border: 1px solid #d5dce3; border-radius: 4px; background: #fff; }
    svg { display: block; }
    .lifeline { stroke: #b8c2cc; stroke-dasharray: 4 4; }
    .participant { font-size: 12px; font-weight: 600; fill: #1f2933; }
    .activation { fill: #e3edf8; stroke: #5b6b7b; stroke-width: 1; }
    .message { stroke: #44505c; stroke-width: 1.4; fill: none; }
    .message.dashed { stroke-dasharray: 5 3; stroke: #8794a1; }
    .label { font-size: 11.5px; fill: #1f2933; }
    .label.leaf { fill: #6b7782; font-style: italic; }
    .fragment rect { fill: rgba(21,101,192,.04); stroke: #8794a1; }
    .fragment .tab { fill: #e4e9ee; stroke: #8794a1; }
    .fragment .kind { font-size: 11px; font-weight: 700; fill: #1f2933; }
    .fragment .guard { font-size: 11px; fill: #44505c; }
    .fragment line { stroke: #8794a1; stroke-dasharray: 6 3; }
    .msg { cursor: default; }
    .msg .hit { stroke: transparent; stroke-width: 14; fill: none; }
    .msg.hot .message { stroke: #b8860b; stroke-width: 2.4; }
    .msg.hot .label { fill: #8a5a00; font-weight: 600; }
  `],
})
export class SequenceViewComponent {
  readonly tree = input.required<CallTree>();
  /** The message under the pointer (its caller and the lines that make the call), or null when the pointer leaves. */
  readonly messageHovered = output<Message | null>();
  protected readonly hoveredMessage = signal<number | null>(null);
  protected readonly layout = computed(() => layoutSequence(this.tree()));
  protected readonly zoom = signal(1);
  protected readonly copied = signal(false);
  private readonly svg = viewChild.required<ElementRef<SVGSVGElement>>('svg');

  protected hoverMessage(index: number | null, message: Message | null): void {
    this.hoveredMessage.set(index);
    this.messageHovered.emit(message);
  }

  protected boxWidth(label: string): number { return Math.max(110, label.length * 7.4 + 24); }
  protected tabWidth(kind: string): number { return kind.length * 8 + 14; }
  protected side(from: number, to: number): number { return from < to ? 6 : -6; }
  protected fill(kind: string, isRoot: boolean): string { return colourOf(isRoot ? 'root' : kind).fill; }
  protected stroke(kind: string, isRoot: boolean): string { return colourOf(isRoot ? 'root' : kind).stroke; }

  protected async copyMermaid(): Promise<void> {
    const text = toMermaid(this.tree());
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      download('sequence.mmd', text, 'text/plain');
    }
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }

  protected saveSvg(): void {
    const clone = this.svg().nativeElement.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(this.layout().width));
    clone.setAttribute('height', String(this.layout().height));
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = 'text{font-family:sans-serif;font-size:11.5px} .participant{font-weight:600;font-size:12px} .lifeline{stroke:#b8c2cc;stroke-dasharray:4 4} .message{stroke:#44505c;stroke-width:1.4;fill:none} .dashed{stroke-dasharray:5 3} .activation{fill:#e3edf8;stroke:#5b6b7b} .fragment rect{fill:none;stroke:#8794a1} .fragment .tab{fill:#e4e9ee;stroke:#8794a1} .fragment line{stroke:#8794a1;stroke-dasharray:6 3} .hit{display:none}';
    clone.prepend(style);
    download('sequence.svg', new XMLSerializer().serializeToString(clone), 'image/svg+xml');
  }
}
