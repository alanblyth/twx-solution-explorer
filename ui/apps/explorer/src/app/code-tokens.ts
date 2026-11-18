import { tokenizer } from 'acorn';

export interface Segment { text: string; kind: 'plain' | 'keyword' | 'string' | 'number' | 'comment' | 'name' | 'punctuation' }

/**
 * Splits source into lines of coloured segments. JavaScript is tokenised with acorn (comments included); SQL, or a script that
 * does not tokenise, gets keyword colouring from a pattern. Segments carry text only, so the view never builds HTML from code.
 */
export function highlightLines(code: string, language: 'javascript' | 'sql' = 'javascript'): Segment[][] {
  const ranges = language === 'javascript' ? javascriptRanges(code) : null;
  return toLines(code, ranges ?? patternRanges(code, language));
}

interface Range { start: number; end: number; kind: Segment['kind'] }

function javascriptRanges(code: string): Range[] | null {
  const ranges: Range[] = [];
  try {
    const comments: Range[] = [];
    const tokens = tokenizer(code, {
      ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true,
      onComment: (_block: boolean, _text: string, start: number, end: number) => comments.push({ start, end, kind: 'comment' }),
    });
    for (const token of tokens) {
      const label = token.type.label;
      const kind: Segment['kind'] = token.type.keyword ? 'keyword'
        : label === 'string' || label === 'template' || label === '`' ? 'string'
        : label === 'num' ? 'number'
        : label === 'name' ? (/^(var|let|const|of|true|false|null|undefined)$/.test(String((token as { value?: unknown }).value)) ? 'keyword' : 'name')
        : 'punctuation';
      ranges.push({ start: token.start, end: token.end, kind });
    }
    ranges.push(...comments);
  } catch {
    return null;
  }
  return ranges.sort((left, right) => left.start - right.start);
}

const SQL_KEYWORDS = /\b(select|from|where|and|or|not|insert|into|values|update|set|delete|join|left|right|inner|outer|on|group|by|order|having|limit|as|in|is|null|create|table|drop)\b/gi;
const JS_KEYWORDS = /\b(var|let|const|function|return|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|new|typeof|instanceof|in|of|true|false|null|undefined|this)\b/g;

function patternRanges(code: string, language: 'javascript' | 'sql'): Range[] {
  const ranges: Range[] = [];
  const add = (pattern: RegExp, kind: Segment['kind']): void => {
    for (const match of code.matchAll(pattern)) {
      const start = match.index ?? 0;
      if (!ranges.some((range) => start < range.end && start + match[0].length > range.start)) ranges.push({ start, end: start + match[0].length, kind });
    }
  };
  add(language === 'sql' ? /--[^\n]*/g : /\/\/[^\n]*|\/\*[\s\S]*?\*\//g, 'comment');
  add(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, 'string');
  add(language === 'sql' ? SQL_KEYWORDS : JS_KEYWORDS, 'keyword');
  add(/\b\d+(?:\.\d+)?\b/g, 'number');
  return ranges.sort((left, right) => left.start - right.start);
}

function toLines(code: string, ranges: Range[]): Segment[][] {
  const segments: Segment[] = [];
  let position = 0;
  for (const range of ranges) {
    if (range.start < position) continue;
    if (range.start > position) segments.push({ text: code.slice(position, range.start), kind: 'plain' });
    segments.push({ text: code.slice(range.start, range.end), kind: range.kind });
    position = range.end;
  }
  if (position < code.length) segments.push({ text: code.slice(position), kind: 'plain' });
  const lines: Segment[][] = [[]];
  for (const segment of segments) {
    const parts = segment.text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, kind: segment.kind });
    });
  }
  return lines;
}
