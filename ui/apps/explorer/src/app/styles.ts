/** Shared look for every component. Each component has its own shadow root, so each includes this text. */
export const SHARED_STYLES = `
  :host { display: block; font: 13px/1.4 "Segoe UI", system-ui, -apple-system, sans-serif; color: #1f2933; box-sizing: border-box; }
  * { box-sizing: border-box; }
  button, select, input { font: inherit; }
  button { border: 1px solid #b8c2cc; background: #fff; border-radius: 4px; padding: 4px 10px; cursor: pointer; color: inherit; }
  button:hover:not(:disabled) { background: #eef2f6; }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { background: #1565c0; border-color: #1565c0; color: #fff; }
  button.primary:hover:not(:disabled) { background: #0f4f9a; }
  input, select { border: 1px solid #b8c2cc; border-radius: 4px; padding: 4px 8px; background: #fff; }
  .muted { color: #6b7782; }
  .error { color: #b3261e; }
  .warn { color: #8a5a00; background: #fff6e0; border: 1px solid #f0d9a0; padding: 6px 10px; border-radius: 4px; }
  .pill { display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 9px; background: #e4e9ee; color: #44505c; }
  .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .spacer { flex: 1; }
`;

/** Colour of a graph or sequence node by kind. */
export const KIND_COLOURS: Record<string, { fill: string; stroke: string }> = {
  root: { fill: '#d6e8fb', stroke: '#1565c0' },
  script: { fill: '#ffffff', stroke: '#5b6b7b' },
  entity: { fill: '#ffffff', stroke: '#5b6b7b' },
  builtin: { fill: '#f1f3f5', stroke: '#a3adb7' },
  platform: { fill: '#f1f3f5', stroke: '#a3adb7' },
  java: { fill: '#f3e8fd', stroke: '#8e44ad' },
  sql: { fill: '#e6f4ea', stroke: '#2e7d32' },
  missing: { fill: '#fdecea', stroke: '#b3261e' },
  dynamic: { fill: '#fff6e0', stroke: '#b8860b' },
  recursive: { fill: '#fff6e0', stroke: '#b8860b' },
  limit: { fill: '#fff6e0', stroke: '#b8860b' },
  package: { fill: '#ffffff', stroke: '#5b6b7b' },
  absent: { fill: '#fdecea', stroke: '#b3261e' },
  selected: { fill: '#ffe9a8', stroke: '#b8860b' },
  incoming: { fill: '#eaf5ea', stroke: '#2e7d32' },
  outgoing: { fill: '#e8f0fd', stroke: '#1565c0' },
};

export function colourOf(kind: string): { fill: string; stroke: string } {
  return KIND_COLOURS[kind] ?? KIND_COLOURS['script'];
}
