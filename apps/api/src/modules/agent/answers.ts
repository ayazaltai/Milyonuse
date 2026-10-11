import { randomBytes } from 'node:crypto';
import { MODEL_CHARS, STORED_CHARS, fit } from './fit.js';

/**
 * A tool's answer: how it is kept, what the model rereads of it, and what the
 * page is sent (ported from App-Milyonus `modules/agent/answers.ts`).
 *
 *   kept      whole, up to STORED_CHARS, shrunk by structure beyond that. A
 *             read's answer is a *source*: kept with a handle (`src-…`) and
 *             the words for where it came from, so `present` can lay out the
 *             tool’s own rows — never the model's rewording of them.
 *   reread    fitted to MODEL_CHARS, valid JSON, with a note when something
 *             was left out and how to see the rest.
 *   shown     a data card whole; any other answer as the model rereads it —
 *             the page draws nothing from those.
 *
 * An answer that is not JSON is read as text, cut at the limit.
 */

/** A source handle, as the model is given it and must give it back. */
export const SOURCE_ID = /^src-[a-z0-9]{6}$/;

/** A new source handle, unique enough within one conversation. */
export function newSourceId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return `src-${[...randomBytes(6)].map((b) => alphabet[b % alphabet.length]).join('')}`;
}

/** A read's answer as a source, as it is kept. */
export interface SourceAnswer {
  source: string;
  /** Where it came from, in words: "Read the table", "Read the document". */
  from: string;
  result: unknown;
}

export function isSourceAnswer(value: unknown): value is SourceAnswer {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['source'] === 'string' && SOURCE_ID.test(v['source']) && 'result' in v;
}

/** The text a source is kept as — its envelope first, so it can be found by its handle. */
export function keepSource(source: string, from: string, result: unknown): string {
  const envelope = `{"source":${JSON.stringify(source)},"from":${JSON.stringify(from)},"result":`;
  return `${envelope}${fit(result, STORED_CHARS - envelope.length - 1).json}}`;
}

/** The prefix a kept source starts with — how the store finds it by its handle. */
export function sourcePrefix(source: string): string {
  return `{"source":${JSON.stringify(source)},`;
}

/** Any other answer, as it is kept. */
export function keepAnswer(data: unknown): string {
  return fit(data, STORED_CHARS).json;
}

const SHORTENED_NOTE =
  'Shortened to fit: lists show their first items and end with how many more there are. To show the person all of it, call present with this source; to read further, ask for a narrower or the next page.';

/**
 * What the model rereads of a kept answer — within `limit` characters: the
 * turn in progress rereads its answers at MODEL_CHARS, an earlier turn's
 * shorter.
 */
export function forModel(content: string, toolName: string | null, limit = MODEL_CHARS): string {
  if (toolName === 'present') return presentedForModel(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Kept before answers were fitted — already cut, as it was then.
    return content.length <= limit ? content : `${content.slice(0, limit)}… (cut short)`;
  }
  if (content.length <= limit) return content;
  if (isSourceAnswer(parsed)) {
    const head = { source: parsed.source, from: parsed.from };
    const fitted = fit(parsed.result, limit - SHORTENED_NOTE.length - 200);
    return JSON.stringify(
      fitted.shortened ? { ...head, note: SHORTENED_NOTE, result: fitted.value } : { ...head, result: fitted.value },
    );
  }
  const fitted = fit(parsed, limit - SHORTENED_NOTE.length - 50);
  return JSON.stringify(fitted.shortened ? { note: SHORTENED_NOTE, result: fitted.value } : fitted.value);
}

/**
 * A data card as the model rereads it: that it is shown and how much — not
 * its rows again on every later step.
 */
function presentedForModel(content: string): string {
  try {
    const card = JSON.parse(content) as {
      presented?: boolean;
      title?: string;
      layout?: string;
      origin?: string;
      source?: { id?: string };
      rows?: unknown[];
      items?: unknown[];
      total?: number;
      shown?: number;
    };
    if (!card.presented) return forModel(content, null);
    const shown = card.shown ?? card.rows?.length ?? card.items?.length ?? 0;
    return JSON.stringify({
      presented: true,
      title: card.title,
      layout: card.layout,
      ...(card.source?.id ? { source: card.source.id } : {}),
      shown,
      ...(card.total !== undefined && card.total !== shown ? { total: card.total } : {}),
      note: 'Shown to the person as a card. Do not repeat its rows in your reply; comment on it briefly.',
    });
  } catch {
    return forModel(content, null);
  }
}

/** What the page is sent of a tool's answer: a card whole, anything else as the model rereads it. */
export function forPage(content: string, toolName: string | null): string {
  return toolName === 'present' ? content : forModel(content, toolName);
}
