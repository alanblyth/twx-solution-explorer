import type { CallTree, ResolvedStep } from './models.ts';
import { entityKey, entityLabel } from './models.ts';
import { textWidth } from './graph-layout.ts';

export interface Participant { id: string; label: string; x: number; kind: string }
export interface Message { y: number; fromX: number; toX: number; label: string; kind: string; self: boolean; dashed: boolean; line: number }
export interface Activation { x: number; y1: number; y2: number; level: number }
export interface Frame { kind: string; label: string; x1: number; x2: number; y1: number; y2: number; dividers: { y: number; label: string }[] }
export interface SequenceLayout {
  participants: Participant[];
  messages: Message[];
  activations: Activation[];
  frames: Frame[];
  width: number;
  height: number;
  headerHeight: number;
}

const ROW = 38;
const HEADER = 46;
const FRAME_HEAD = 22;
const FRAME_FOOT = 10;
const MARGIN = 30;

interface Range { low: number; high: number }

/** Lays a call tree out as a sequence diagram: lifelines in order of first appearance, one row per message. */
export function layoutSequence(tree: CallTree): SequenceLayout {
  const order: { id: string; label: string; kind: string }[] = [];
  const indexOf = new Map<string, number>();
  const ensure = (node: CallTree): number => {
    const id = participantId(node);
    let index = indexOf.get(id);
    if (index === undefined) {
      index = order.length;
      indexOf.set(id, index);
      order.push({ id, label: participantLabel(node), kind: node.kind === 'dynamic' ? 'dynamic' : node.kind === 'platform' ? 'platform' : 'entity' });
    }
    return index;
  };
  ensure(tree);

  const messages: { y: number; from: number; to: number; label: string; kind: string; dashed: boolean; line: number }[] = [];
  const activations: { index: number; y1: number; y2: number; level: number }[] = [];
  const frames: { kind: string; label: string; low: number; high: number; y1: number; y2: number; dividers: { y: number; label: string }[] }[] = [];
  const levelOf = new Map<number, number>();
  let y = HEADER + ROW / 2;

  const emitSteps = (steps: ResolvedStep[], callerIndex: number): Range => {
    const range: Range = { low: callerIndex, high: callerIndex };
    for (const step of steps) {
      if (step.type === 'call') {
        const part = emitCall(step.callee, callerIndex, step.line);
        range.low = Math.min(range.low, part.low);
        range.high = Math.max(range.high, part.high);
      } else {
        const frame = { kind: step.kind, label: step.label, low: callerIndex, high: callerIndex, y1: y, y2: y, dividers: [] as { y: number; label: string }[] };
        frames.push(frame);
        y += FRAME_HEAD;
        step.branches.forEach((branch, branchIndex) => {
          if (branchIndex > 0) {
            frame.dividers.push({ y: y - ROW / 2 + 6, label: branch.label });
            y += 16;
          }
          const part = emitSteps(branch.steps, callerIndex);
          frame.low = Math.min(frame.low, part.low);
          frame.high = Math.max(frame.high, part.high);
        });
        frame.y2 = y - ROW / 2 + 4;
        y += FRAME_FOOT;
        range.low = Math.min(range.low, frame.low);
        range.high = Math.max(range.high, frame.high);
      }
    }
    return range;
  };

  const emitCall = (node: CallTree, callerIndex: number, line: number): Range => {
    const calleeIndex = ensure(node);
    const callRow = y;
    messages.push({ y: callRow, from: callerIndex, to: calleeIndex, label: `${node.service}()`, kind: node.kind, dashed: false, line });
    y += ROW;
    const range: Range = { low: Math.min(callerIndex, calleeIndex), high: Math.max(callerIndex, calleeIndex) };
    if (node.steps.length) {
      const level = levelOf.get(calleeIndex) ?? 0;
      levelOf.set(calleeIndex, level + 1);
      const top = callRow;
      const inner = emitSteps(node.steps, calleeIndex);
      range.low = Math.min(range.low, inner.low);
      range.high = Math.max(range.high, inner.high);
      messages.push({ y, from: calleeIndex, to: callerIndex, label: '', kind: node.kind, dashed: true, line });
      activations.push({ index: calleeIndex, y1: top, y2: y, level });
      levelOf.set(calleeIndex, level);
      y += ROW * 0.6;
    }
    return range;
  };

  emitSteps(tree.steps, 0);

  const widest = Math.max(...order.map((item) => textWidth(item.label)), 80);
  const column = Math.max(170, widest + 40);
  const xOf = (index: number): number => MARGIN + column / 2 + index * column;
  const participants = order.map((item, index) => ({ ...item, x: xOf(index) }));
  const framePadding = 14;
  return {
    participants,
    messages: messages.map((message) => ({
      y: message.y, fromX: xOf(message.from), toX: xOf(message.to), label: message.label, kind: message.kind,
      self: message.from === message.to, dashed: message.dashed, line: message.line,
    })),
    activations: activations.map((activation) => ({ x: xOf(activation.index), y1: activation.y1, y2: activation.y2, level: activation.level })),
    frames: frames.map((frame) => ({
      kind: frame.kind, label: frame.label, x1: xOf(frame.low) - column / 2 + framePadding, x2: xOf(frame.high) + column / 2 - framePadding,
      y1: frame.y1 - 8, y2: frame.y2, dividers: frame.dividers,
    })),
    width: MARGIN * 2 + column * order.length,
    height: y + ROW,
    headerHeight: HEADER,
  };
}

function participantId(node: CallTree): string {
  return node.entity.dynamic || node.entity.name === null ? `dynamic:${entityKey(node.entity)}` : entityKey(node.entity);
}

function participantLabel(node: CallTree): string {
  if (node.entity.name === null) return `${node.entity.collection}[?]`;
  return entityLabel(node.entity);
}

/** Mermaid `sequenceDiagram` source for the same tree, to paste into any Mermaid renderer. */
export function toMermaid(tree: CallTree): string {
  const layout: string[] = ['sequenceDiagram'];
  const ids = new Map<string, string>();
  const idFor = (node: CallTree): string => {
    const key = participantId(node);
    let id = ids.get(key);
    if (!id) {
      id = `p${ids.size}`;
      ids.set(key, id);
      layout.push(`  participant ${id} as ${participantLabel(node).replace(/[;#]/g, ' ')}`);
    }
    return id;
  };
  const rootId = idFor(tree);
  const emit = (steps: ResolvedStep[], caller: string, indent: string): void => {
    for (const step of steps) {
      if (step.type === 'call') {
        const callee = idFor(step.callee);
        layout.push(`${indent}${caller}->>${callee}: ${step.callee.service}()`);
        if (step.callee.steps.length) {
          layout.push(`${indent}activate ${callee}`);
          emit(step.callee.steps, callee, indent);
          layout.push(`${indent}${callee}-->>${caller}: return`);
          layout.push(`${indent}deactivate ${callee}`);
        }
      } else {
        const keyword = step.kind === 'loop' ? 'loop' : step.kind === 'opt' ? 'opt' : step.kind === 'try' ? 'alt' : 'alt';
        step.branches.forEach((branch, index) => {
          const label = branch.label.replace(/[;#]/g, ' ');
          layout.push(index === 0 ? `${indent}${keyword} ${label}` : `${indent}else ${label}`);
          emit(branch.steps, caller, `${indent}  `);
        });
        layout.push(`${indent}end`);
      }
    }
  };
  emit(tree.steps, rootId, '  ');
  return layout.join('\n');
}
