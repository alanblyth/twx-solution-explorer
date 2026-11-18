import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeScript, flattenCalls, ME } from '../apps/explorer/src/app/js-analyzer.ts';

const names = (code: string) => flattenCalls(analyzeScript(code).steps).map((c) => `${c.target.collection}/${c.target.name}.${c.service}`);

test('finds calls on Things by bracket and dot notation, in source order', () => {
  assert.deepEqual(names(`Things["A"].One(); Things.B.Two({x: 1}); Resources["R"].Three();`),
    ['Things/A.One', 'Things/B.Two', 'Resources/R.Three']);
});

test('follows string constants and entity variables', () => {
  const code = `var REG = "CM.Registry"; var t = Things[REG]; t.Query(); Things[REG].Other();`;
  assert.deepEqual(names(code), ['Things/CM.Registry.Query', 'Things/CM.Registry.Other']);
});

test('a partly known name is dynamic', () => {
  const [step] = flattenCalls(analyzeScript(`Things["CM.GW." + gatewayName].Ping();`).steps);
  assert.equal(step.target.name, 'CM.GW.{gatewayName}');
  assert.equal(step.target.dynamic, true);
});

test('an unknown name has a null target name', () => {
  const [step] = flattenCalls(analyzeScript(`Things[someThing.name].Ping();`).steps);
  assert.equal(step.target.name, null);
  assert.equal(step.target.dynamic, true);
});

test('me and this resolve to the owning entity marker', () => {
  const calls = flattenCalls(analyzeScript(`me.Helper(); this.Other();`).steps);
  assert.deepEqual(calls.map((c) => [c.target.collection, c.service]), [[ME, 'Helper'], [ME, 'Other']]);
});

test('calls inside arguments run before the outer call', () => {
  assert.deepEqual(names(`Things["A"].Outer(Things["B"].Inner());`), ['Things/B.Inner', 'Things/A.Outer']);
});

test('local functions are inlined where called, and recursion stops', () => {
  const code = `function helper() { Things["H"].Run(); helper(); } helper(); helper();`;
  assert.deepEqual(names(code), ['Things/H.Run', 'Things/H.Run']);
});

test('if / else-if / else becomes one alt frame; an if without else is opt', () => {
  const { steps } = analyzeScript(`if (a) { Things["A"].X(); } else if (b) { Things["B"].Y(); } else { Things["C"].Z(); }
    if (c) { Things["D"].W(); }`);
  assert.equal(steps.length, 2);
  const [alt, opt] = steps as any[];
  assert.equal(alt.kind, 'alt');
  assert.deepEqual(alt.branches.map((b: any) => b.label), ['a', 'else if b', 'else']);
  assert.equal(opt.kind, 'opt');
});

test('loops and try/catch are framed, a bare try is flattened', () => {
  const { steps } = analyzeScript(`for (var i = 0; i < 3; i++) { Things["L"].Go(); }
    try { Things["T"].Go(); } catch (e) { Things["E"].Log(); }
    try { Things["U"].Go(); } finally { }`);
  const kinds = steps.map((s) => (s.type === 'frame' ? s.kind : 'call'));
  assert.deepEqual(kinds, ['loop', 'try', 'call']);
});

test('conditions without calls produce no frame', () => {
  assert.deepEqual(analyzeScript(`if (a) { var x = 1; }`).steps, []);
});

test('property reads and calls on other objects are not service calls', () => {
  assert.deepEqual(names(`var v = Things["A"].prop; me.table.AddRow({}); Math.max(1, 2); params.rows.length;`), []);
});

test('a script that does not parse falls back to a pattern match and says so', () => {
  const result = analyzeScript(`Things["A"].One( ;;; me.Two();`);
  assert.ok(result.parseError);
  assert.deepEqual(flattenCalls(result.steps).map((c) => c.service), ['One', 'Two']);
});

test('modern syntax parses', () => {
  assert.deepEqual(names('const run = (n) => { Things[`T${n}`].Go(); }; run(1);'), ['Things/T{n}.Go']);
});

test('arguments are bound to the parameters of an inlined helper', () => {
  const code = `function findRows(tableName, value) { var table = Things[tableName]; return table.Query({ v: value }); }
    findRows("CM.Registry", 1); findRows("CM.Profiles", 2);`;
  assert.deepEqual(names(code), ['Things/CM.Registry.Query', 'Things/CM.Profiles.Query']);
});

test('an entity passed to a helper is followed, and an unknown argument stays dynamic', () => {
  const code = `function go(t) { t.Run(); } go(Things["A"]); go(somethingElse);`;
  const calls = flattenCalls(analyzeScript(code).steps);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target.name, 'A');
});
