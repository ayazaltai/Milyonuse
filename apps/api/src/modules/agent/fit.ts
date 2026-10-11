/**
 * Fitting a tool’s answer into a budget without lying about it (ported from
 * App-Milyonus `modules/agent/fit.ts`).
 *
 * A read can answer far more than the model should reread on every step, or
 * than a message may hold (0006: 200,000 characters). Cutting the text at a
 * character count leaves broken JSON, and a model reading a page of a list as
 * the whole list counts wrong. Fitting shrinks the *structure* instead: long
 * lists keep their first items and end with a line that says how many more
 * there are and how many in all; long strings are shortened; the result is
 * always valid JSON.
 */

/** The model rereads at most this much of one answer on a later step. */
export const MODEL_CHARS = 12_000;
/** What one stored answer may take — inside 0006’s 200,000, with room for its envelope. */
export const STORED_CHARS = 190_000;

const MAX_DEPTH = 10;

/** From generous to tight: [items kept per list, characters kept per string]. */
const LADDER: readonly (readonly [number, number])[] = [
  [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
  [1000, 4000],
  [500, 2000],
  [200, 1000],
  [100, 500],
  [50, 500],
  [25, 300],
  [10, 200],
  [5, 120],
  [2, 80],
  [1, 60],
];

export interface Fitted {
  value: unknown;
  json: string;
  /** Something was left out. */
  shortened: boolean;
}

/** The line that closes a shortened list. `present` reads it back (omittedOf). */
export function omissionLine(more: number, all: number): string {
  return `… ${more.toLocaleString('en-US')} more not shown (${all.toLocaleString('en-US')} in all)`;
}

const OMISSION = /^… ([\d,]+) more not shown \(([\d,]+) in all\)$/;

/** A list's closing omission line, when it has one: how many were left out, and the whole count. */
export function omittedOf(value: unknown): { more: number; all: number } | null {
  if (typeof value !== 'string') return null;
  const match = OMISSION.exec(value);
  if (!match) return null;
  return { more: Number(match[1]!.replace(/,/g, '')), all: Number(match[2]!.replace(/,/g, '')) };
}

/** `value` as JSON of at most `budget` characters, shrunk by structure, never cut mid-way. */
export function fit(value: unknown, budget: number): Fitted {
  for (const [items, chars] of LADDER) {
    const state = { shortened: false };
    const shrunk = shrink(value, items, chars, 0, state);
    const json = JSON.stringify(shrunk) ?? 'null';
    if (json.length <= budget) return { value: shrunk, json, shortened: state.shortened };
  }
  // Deep or wide beyond any list or string: say so, with the start of it as text.
  const whole = JSON.stringify(value) ?? 'null';
  const fallback = {
    shortened: 'This answer is too large to show whole; its beginning follows as text.',
    beginning: whole.slice(0, Math.max(0, budget - 200)),
  };
  return { value: fallback, json: JSON.stringify(fallback), shortened: true };
}

function shrink(
  value: unknown,
  items: number,
  chars: number,
  depth: number,
  state: { shortened: boolean },
): unknown {
  if (typeof value === 'string') {
    if (value.length <= chars) return value;
    state.shortened = true;
    return `${value.slice(0, chars)}…`;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) {
    state.shortened = true;
    return '…';
  }
  if (Array.isArray(value)) {
    // A list already shortened once (on storage) keeps its own count of the whole.
    const closing = omittedOf(value.at(-1));
    const body = closing ? value.slice(0, -1) : value;
    const all = closing ? closing.all : body.length;
    const kept = body.slice(0, items).map((v) => shrink(v, items, chars, depth + 1, state));
    if (kept.length < all) {
      state.shortened = true;
      kept.push(omissionLine(all - kept.length, all));
    }
    return kept;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  // A record keyed by id is a list in disguise: as wide as a list may be, at least fifty.
  const width = Math.max(50, items);
  const out: Record<string, unknown> = {};
  for (const [key, v] of entries.slice(0, width)) out[key] = shrink(v, items, chars, depth + 1, state);
  if (entries.length > width) {
    state.shortened = true;
    out['…'] = `${(entries.length - width).toLocaleString('en-US')} more fields not shown`;
  }
  return out;
}
