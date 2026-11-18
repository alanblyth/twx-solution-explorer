import { ChangeDetectionStrategy, Component, ElementRef, ViewEncapsulation, afterRenderEffect, computed, input, viewChild } from '@angular/core';
import { SHARED_STYLES } from './styles.ts';
import { highlightLines } from './code-tokens.ts';

/**
 * Read-only source with line numbers and coloured tokens. The chosen lines get a highlighted background and the first one is
 * scrolled into view. The DOM is built from text segments by bindings, never from HTML, so a script cannot inject markup.
 */
@Component({
  selector: 'se-code-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.ShadowDom,
  template: `
    <div class="head">
      <b class="title" [title]="title()">{{ title() }}</b>
      @if (code() !== null) { <span class="pill">{{ language() === 'sql' ? 'SQL' : 'JavaScript' }}</span> }
      @if (highlighted().length) { <span class="muted">line{{ highlighted().length === 1 ? '' : 's' }} {{ sortedLines().join(', ') }}</span> }
    </div>
    @if (code() !== null) {
      <div #scroller class="code">
        @for (line of lines(); track $index) {
          <div class="line" [class.hot]="hotLines().has($index + 1)"><span class="number">{{ $index + 1 }}</span><span class="text">@for (segment of line; track $index) {<span [class]="segment.kind">{{ segment.text }}</span>}</span></div>
        }
      </div>
    } @else {
      <p class="muted reason">{{ reason() }}</p>
    }
  `,
  styles: [SHARED_STYLES, `
    :host { display: flex; flex-direction: column; min-height: 0; height: 100%; }
    .head { display: flex; gap: 8px; align-items: baseline; padding: 4px 0 6px; min-width: 0; }
    .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .code { position: relative; flex: 1; min-height: 0; overflow: auto; border: 1px solid #d5dce3; border-radius: 4px; background: #fff;
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 4px 0; }
    .line { display: flex; min-width: max-content; }
    .line.hot { background: #fff1b8; box-shadow: inset 3px 0 #b8860b; }
    .number { flex: 0 0 auto; width: 3.5em; padding-right: 10px; text-align: right; color: #a3adb7; user-select: none; }
    .text { white-space: pre; padding-right: 12px; }
    .keyword { color: #8e24aa; font-weight: 600; } .string { color: #2e7d32; } .number-token { color: #b35c00; }
    .comment { color: #8794a1; font-style: italic; } .name { color: #1f2933; } .punctuation { color: #44505c; }
    .reason { padding: 10px; border: 1px dashed #d5dce3; border-radius: 4px; margin: 0; }
  `],
})
export class CodeViewComponent {
  /** The source, or null when there is none (then `reason` says why). */
  readonly code = input<string | null>(null);
  readonly language = input<'javascript' | 'sql'>('javascript');
  /** 1-based line numbers to highlight. */
  readonly highlighted = input<number[]>([]);
  readonly title = input('');
  readonly reason = input('No source to show.');

  protected readonly lines = computed(() => {
    const lines = highlightLines(this.code() ?? '', this.language());
    // "number" is also the line-number class, so number tokens get their own class name.
    return lines.map((line) => line.map((segment) => (segment.kind === 'number' ? { ...segment, kind: 'number-token' } : segment)));
  });
  protected readonly hotLines = computed(() => new Set(this.highlighted()));
  protected readonly sortedLines = computed(() => [...this.hotLines()].sort((left, right) => left - right));
  private shownCode: string | null = null;
  private readonly scroller = viewChild<ElementRef<HTMLDivElement>>('scroller');

  constructor() {
    afterRenderEffect(() => {
      const element = this.scroller()?.nativeElement;
      const first = Math.min(...this.highlighted());
      const code = this.code();
      this.lines();
      if (!element) return;
      const codeChanged = code !== this.shownCode;
      this.shownCode = code;
      if (!Number.isFinite(first)) {
        if (codeChanged) element.scrollTop = 0;
        return;
      }
      const line = element.querySelectorAll<HTMLElement>('.line')[first - 1];
      if (!line) return;
      const top = line.offsetTop;
      if (top < element.scrollTop || top + line.offsetHeight > element.scrollTop + element.clientHeight) {
        element.scrollTop = Math.max(0, top - element.clientHeight / 3);
      }
    });
  }
}
