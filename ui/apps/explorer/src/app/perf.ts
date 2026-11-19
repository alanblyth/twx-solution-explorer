/**
 * Performance marks for measuring scans, layout and rendering, behind a debug flag. Off by default: every call returns at
 * once. Switch it on with `se-perf=1` in the page's query string, or `localStorage['se.perf'] = '1'`.
 *
 * Each measure is a User Timing entry named `se:<area>:<phase>` with a `detail` (counts), so it shows in the browser's
 * performance panel; `window.__sePerf.entries()` returns them as plain objects and `clear()` removes them. No Angular here,
 * so the pure modules (graph-layout) can use it and node can run them.
 */

const PREFIX = 'se:';

function readFlag(): boolean {
  try {
    const host = globalThis as { location?: { search?: string }; localStorage?: Storage };
    if (host.location?.search && new URLSearchParams(host.location.search).get('se-perf') === '1') return true;
    return host.localStorage?.getItem('se.perf') === '1';
  } catch {
    return false;
  }
}

let enabled = readFlag();

export function perfEnabled(): boolean { return enabled; }

/** For tests and the in-page hook. */
export function setPerfEnabled(value: boolean): void { enabled = value; }

export interface PerfEntry { name: string; start: number; duration: number; detail: Record<string, unknown> }

/** Starts a measure; call the returned function to end it. */
export function perfStart(name: string, detail: Record<string, unknown> = {}): (moreDetail?: Record<string, unknown>) => void {
  if (!enabled) return () => undefined;
  const start = performance.now();
  return (moreDetail = {}) => {
    try {
      performance.measure(PREFIX + name, { start, end: performance.now(), detail: { ...detail, ...moreDetail } });
    } catch {
      // a browser without the User Timing level 3 options: nothing is recorded
    }
  };
}

/** Times synchronous work. */
export function perfSync<Result>(name: string, work: () => Result, detail: (result: Result) => Record<string, unknown> = () => ({})): Result {
  if (!enabled) return work();
  const end = perfStart(name);
  const result = work();
  end(detail(result));
  return result;
}

/**
 * Ends a measure once the view has been updated and the browser has computed style and layout for it (a forced reflow in
 * the next task). Paint is left out, because animation frames do not run while the page is hidden and would stretch the
 * measure to the next visible frame.
 */
export function perfUntilRendered(name: string, detail: Record<string, unknown> = {}): void {
  if (!enabled) return;
  const end = perfStart(name, detail);
  setTimeout(() => {
    const host = globalThis as { document?: Document };
    void host.document?.body?.offsetHeight;   // forces style and layout of the page, shadow roots included
    end();
  }, 0);
}

export function perfEntries(): PerfEntry[] {
  if (typeof performance.getEntriesByType !== 'function') return [];
  return performance.getEntriesByType('measure').filter((entry) => entry.name.startsWith(PREFIX))
    .map((entry) => ({ name: entry.name.slice(PREFIX.length), start: Math.round(entry.startTime), duration: Math.round(entry.duration),
      detail: ((entry as PerformanceMeasure).detail ?? {}) as Record<string, unknown> }));
}

export function perfClear(): void {
  for (const entry of performance.getEntriesByType?.('measure') ?? []) if (entry.name.startsWith(PREFIX)) performance.clearMeasures(entry.name);
}
