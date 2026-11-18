import { parse } from 'acorn';
import type { AnalysisResult, CallStep, EntityRef, FrameStep, Step } from './models.ts';

/** Global objects through which a ThingWorx script reaches an entity: `Things["Name"]`, `Resources["Name"]`, ... */
export const ENTITY_COLLECTIONS = new Set([
  'Things', 'ThingTemplates', 'ThingShapes', 'Resources', 'Subsystems', 'DataShapes', 'Users', 'Groups',
  'Organizations', 'Projects', 'Mashups', 'Dashboards', 'Networks', 'Authenticators', 'Directories',
  'MediaEntities', 'Menus', 'ModelTagVocabularies', 'DataTags', 'StateDefinitions', 'StyleDefinitions',
  'ApplicationKeys', 'Blogs', 'Wikis', 'Widgets', 'LocalizationTables', 'Logs',
]);

/** Marker collection for `me` / `this`: the entity the script belongs to, filled in by whoever resolves the call. */
export const ME = '@me';

const MAX_INLINE_DEPTH = 8;
const LABEL_LENGTH = 48;

type Node = any; // acorn's node types are structural; the analyser only reads known fields

interface Scope {
  strings: Map<string, StringValue>;
  entities: Map<string, EntityRef>;
  functions: Map<string, Node>;
}

interface StringValue { text: string; dynamic: boolean }

/**
 * Finds every call a ThingWorx script makes to a service on another entity (or on `me`), in source order, with the
 * if/loop/try structure around it. String variables are followed (`var T = "CM.Registry"; Things[T]`), so are variables that
 * hold an entity (`var t = Things["A"]; t.Foo()`) and calls to functions declared in the same script.
 */
export function analyzeScript(code: string): AnalysisResult {
  let program: Node;
  try {
    program = parse(code, { ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, locations: true });
  } catch (error) {
    return { steps: regexFallback(code), parseError: error instanceof Error ? error.message : String(error) };
  }
  const scope: Scope = { strings: new Map(), entities: new Map(), functions: new Map() };
  collectDeclarations(program, scope);
  const walker = new Walker(code, scope);
  return { steps: walker.statements(program.body, []) };
}

/** Pass one: remember string constants, entity variables and function declarations anywhere in the script (one flat scope). */
function collectDeclarations(root: Node, scope: Scope): void {
  const visit = (node: Node): void => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'FunctionDeclaration' && node.id) scope.functions.set(node.id.name, node);
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
      const name = node.id.name;
      if (node.init.type === 'FunctionExpression' || node.init.type === 'ArrowFunctionExpression') {
        scope.functions.set(name, node.init);
      } else {
        const text = evaluateString(node.init, scope);
        if (text && !text.dynamic) scope.strings.set(name, text);
        const entity = resolveEntity(node.init, scope);
        if (entity) scope.entities.set(name, entity);
      }
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child.type === 'string') visit(child);
    }
  };
  visit(root);
}

function evaluateString(node: Node, scope: Scope): StringValue | null {
  switch (node?.type) {
    case 'Literal':
      return typeof node.value === 'string' ? { text: node.value, dynamic: false } : null;
    case 'Identifier': {
      const known = scope.strings.get(node.name);
      return known ?? { text: `{${node.name}}`, dynamic: true };
    }
    case 'TemplateLiteral': {
      let text = '';
      let dynamic = false;
      node.quasis.forEach((part: Node, index: number) => {
        text += part.value.cooked ?? '';
        const expression = node.expressions[index];
        if (expression) {
          const inner = evaluateString(expression, scope) ?? { text: `{${sourceName(expression)}}`, dynamic: true };
          text += inner.text;
          dynamic ||= inner.dynamic;
        }
      });
      return { text, dynamic };
    }
    case 'BinaryExpression': {
      if (node.operator !== '+') return null;
      const left = evaluateString(node.left, scope) ?? placeholder(node.left);
      const right = evaluateString(node.right, scope) ?? placeholder(node.right);
      return { text: left.text + right.text, dynamic: left.dynamic || right.dynamic };
    }
    default:
      return null;
  }
}

function placeholder(node: Node): StringValue {
  if (node?.type === 'Literal') return { text: String(node.value), dynamic: false };
  return { text: `{${sourceName(node)}}`, dynamic: true };
}

function sourceName(node: Node): string {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'MemberExpression') return `${sourceName(node.object)}.${node.computed ? '[]' : sourceName(node.property)}`;
  return '?';
}

/** `Things["A"]`, `Things.A`, `me`, or a variable known to hold one of these. */
function resolveEntity(node: Node, scope: Scope): EntityRef | null {
  if (!node) return null;
  if (node.type === 'ThisExpression') return { collection: ME, name: null };
  if (node.type === 'Identifier') {
    if (node.name === 'me') return { collection: ME, name: null };
    return scope.entities.get(node.name) ?? null;
  }
  if (node.type === 'MemberExpression' && node.object?.type === 'Identifier' && ENTITY_COLLECTIONS.has(node.object.name)) {
    const collection = node.object.name;
    if (!node.computed) return { collection, name: node.property.name };
    const name = evaluateString(node.property, scope);
    if (!name) return { collection, name: null, dynamic: true };
    return { collection, name: name.text, dynamic: name.dynamic || undefined };
  }
  return null;
}

class Walker {
  private readonly inlineStack: string[] = [];
  private readonly inlineLines: number[] = [];
  private readonly code: string;
  private scope: Scope;

  constructor(code: string, scope: Scope) {
    this.code = code;
    this.scope = scope;
  }

  statements(nodes: Node[], into: Step[]): Step[] {
    for (const node of nodes) this.visit(node, into);
    return into;
  }

  private label(node: Node): string {
    const text = this.code.slice(node.start, node.end).replace(/\s+/g, ' ').trim();
    return text.length > LABEL_LENGTH ? `${text.slice(0, LABEL_LENGTH - 1)}…` : text;
  }

  private block(node: Node | null | undefined): Step[] {
    const steps: Step[] = [];
    if (node) this.visit(node, steps);
    return steps;
  }

  /** Visit a node and append the calls it makes, in execution order. */
  private visit(node: Node, into: Step[]): void {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'FunctionDeclaration':
        return; // only walked when something calls it
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return;
      case 'IfStatement':
        return this.visitIf(node, into);
      case 'ForStatement':
        this.visit(node.init, into);
        return this.loop(node, [node.test, node.update], node.body, into);
      case 'ForInStatement':
      case 'ForOfStatement':
        this.visit(node.right, into);
        return this.loop(node, [], node.body, into);
      case 'WhileStatement':
        return this.loop(node, [node.test], node.body, into);
      case 'DoWhileStatement':
        return this.loop(node, [node.test], node.body, into);
      case 'TryStatement':
        return this.visitTry(node, into);
      case 'SwitchStatement':
        return this.visitSwitch(node, into);
      case 'ConditionalExpression': {
        this.visit(node.test, into);
        const branches = [
          { label: this.label(node.test), steps: this.block(node.consequent) },
          { label: 'else', steps: this.block(node.alternate) },
        ].filter((branch) => branch.steps.length > 0);
        return this.pushFrame(into, branches.length > 1 ? 'alt' : 'opt', branches, node);
      }
      case 'LogicalExpression': {
        this.visit(node.left, into);
        const right = this.block(node.right);
        if (right.length) this.pushFrame(into, 'opt', [{ label: `${this.label(node.left)} ${node.operator}`, steps: right }], node);
        return;
      }
      case 'CallExpression':
        return this.visitCall(node, into);
      default:
        break;
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach((item) => this.visit(item, into));
      else if (child && typeof child.type === 'string') this.visit(child, into);
    }
  }

  private visitCall(node: Node, into: Step[]): void {
    const callee = node.callee;
    if (callee.type === 'MemberExpression') {
      // The object may itself contain calls (`Things["A"].Foo().rows`): they run first.
      const target = resolveEntity(callee.object, this.scope);
      if (!target) this.visit(callee.object, into);
      this.visitArguments(node.arguments, into);
      const service = callee.computed ? evaluateString(callee.property, this.scope)?.text : callee.property.name;
      if (target && service) {
        const line = node.loc?.start.line ?? 0;
        const step: CallStep = { type: 'call', target, service, line, lines: [...this.inlineLines, line] };
        into.push(step);
      }
      return;
    }
    this.visitArguments(node.arguments, into);
    if (callee.type === 'Identifier') this.inline(callee.name, node.arguments, into, node.loc?.start.line ?? 0);
    else this.visit(callee, into);
  }

  /** Arguments run before the call. A function passed as an argument (a callback) is shown as a loop over its body. */
  private visitArguments(args: Node[], into: Step[]): void {
    for (const argument of args) {
      if (argument.type === 'FunctionExpression' || argument.type === 'ArrowFunctionExpression') {
        const body = this.block(argument.body);
        if (body.length) this.pushFrame(into, 'loop', [{ label: 'callback', steps: body }], argument);
      } else {
        this.visit(argument, into);
      }
    }
  }

  /**
   * Walks a local function where it is called. The arguments are bound to the parameters first, so a helper such as
   * `findRows(tableName, ...)` called with `"CM.Registry"` calls `Things["CM.Registry"]`, not `Things[tableName]`.
   */
  private inline(name: string, args: Node[], into: Step[], callLine: number): void {
    const fn = this.scope.functions.get(name);
    if (!fn || this.inlineStack.includes(name) || this.inlineStack.length >= MAX_INLINE_DEPTH) return;
    const callerScope = this.scope;
    const local: Scope = { strings: new Map(callerScope.strings), entities: new Map(callerScope.entities), functions: new Map(callerScope.functions) };
    (fn.params as Node[]).forEach((parameter, index) => {
      if (parameter.type !== 'Identifier') return;
      local.strings.delete(parameter.name);
      local.entities.delete(parameter.name);
      const argument = args[index];
      if (!argument) return;
      const text = evaluateString(argument, callerScope);
      if (text && !text.dynamic) local.strings.set(parameter.name, text);
      const entity = resolveEntity(argument, callerScope);
      if (entity) local.entities.set(parameter.name, entity);
    });
    if (fn.body?.type === 'BlockStatement') collectDeclarations(fn.body, local);
    this.scope = local;
    this.inlineStack.push(name);
    this.inlineLines.push(callLine);
    try {
      this.visit(fn.body, into);
    } finally {
      this.inlineStack.pop();
      this.inlineLines.pop();
      this.scope = callerScope;
    }
  }

  private visitIf(node: Node, into: Step[]): void {
    this.visit(node.test, into);
    const branches: { label: string; steps: Step[] }[] = [{ label: this.label(node.test), steps: this.block(node.consequent) }];
    let alternate = node.alternate;
    while (alternate?.type === 'IfStatement') {
      branches.push({ label: `else if ${this.label(alternate.test)}`, steps: [...this.block(alternate.test), ...this.block(alternate.consequent)] });
      alternate = alternate.alternate;
    }
    if (alternate) branches.push({ label: 'else', steps: this.block(alternate) });
    const used = branches.filter((branch) => branch.steps.length > 0);
    this.pushFrame(into, node.alternate ? 'alt' : 'opt', used, node);
  }

  private loop(node: Node, headerParts: Node[], body: Node, into: Step[]): void {
    for (const part of headerParts) this.visit(part, into);
    const steps = this.block(body);
    if (steps.length) this.pushFrame(into, 'loop', [{ label: this.loopLabel(node), steps }], node);
  }

  private loopLabel(node: Node): string {
    const header = this.code.slice(node.start, node.body.start).replace(/\s+/g, ' ').trim();
    return header.length > LABEL_LENGTH ? `${header.slice(0, LABEL_LENGTH - 1)}…` : header;
  }

  private visitTry(node: Node, into: Step[]): void {
    const tried = this.block(node.block);
    const caught = this.block(node.handler?.body);
    const finalized = this.block(node.finalizer);
    if (!caught.length && !finalized.length) {
      into.push(...tried);
      return;
    }
    const branches = [
      { label: 'try', steps: tried },
      { label: 'catch', steps: caught },
      { label: 'finally', steps: finalized },
    ].filter((branch) => branch.steps.length > 0);
    this.pushFrame(into, 'try', branches, node);
  }

  private visitSwitch(node: Node, into: Step[]): void {
    this.visit(node.discriminant, into);
    const branches = node.cases
      .map((item: Node) => ({
        label: item.test ? `case ${this.label(item.test)}` : 'default',
        steps: this.block({ type: 'BlockStatement', body: item.consequent }),
      }))
      .filter((branch: { steps: Step[] }) => branch.steps.length > 0);
    this.pushFrame(into, 'alt', branches, node);
  }

  /** Adds a frame, or just the calls when there is nothing to frame. */
  private pushFrame(into: Step[], kind: FrameStep['kind'], branches: { label: string; steps: Step[] }[], node: Node): void {
    if (!branches.length) return;
    into.push({ type: 'frame', kind, label: branches[0].label, branches, line: node.loc?.start.line ?? 0 });
  }
}

/** When the script does not parse, at least report the calls a pattern match can see. */
function regexFallback(code: string): Step[] {
  const steps: Step[] = [];
  const pattern = /\b(Things|ThingTemplates|ThingShapes|Resources|Subsystems)\s*(?:\[\s*["']([^"']+)["']\s*\]|\.([A-Za-z_$][\w$]*))\s*\.\s*([A-Za-z_$][\w$]*)\s*\(|\bme\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code))) {
    const line = code.slice(0, match.index).split('\n').length;
    if (match[1]) steps.push({ type: 'call', target: { collection: match[1], name: match[2] ?? match[3] }, service: match[4], line, lines: [line] });
    else steps.push({ type: 'call', target: { collection: ME, name: null }, service: match[5], line, lines: [line] });
  }
  return steps;
}

/** Every call in a step list, flattened (frames opened), for counting and graph edges. */
export function flattenCalls(steps: Step[]): CallStep[] {
  const calls: CallStep[] = [];
  for (const step of steps) {
    if (step.type === 'call') calls.push(step);
    else step.branches.forEach((branch) => calls.push(...flattenCalls(branch.steps)));
  }
  return calls;
}
