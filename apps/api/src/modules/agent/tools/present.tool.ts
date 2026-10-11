import { z } from 'zod';
import { SOURCE_ID, isSourceAnswer } from '../answers.js';
import { STORED_CHARS, omittedOf } from '../fit.js';
import type { AgentStore } from '../agent.store.js';
import { type AgentTool, ToolError, tool } from './tool.js';

/**
 * `present` — data laid out as a card, from a read's own answer (ported from
 * App-Milyonus `modules/agent/tools/present.tool.ts`).
 *
 * The model names a read's answer by its source handle and says what to show
 * and how; the server takes the rows from that answer as the tool gave it
 * and writes the card. The model never types the values, so a card cannot
 * misquote a name, a score or a count — and a table of a thousand lines costs
 * the model nothing to show.
 *
 * Values the model worked out itself — a sum, an average, a comparison — may
 * still be shown, a few at most, and the card says who wrote them.
 */

/** Lines a card from a source may hold; the card says when the source held more. */
export const CARD_ROWS = 2000;
/** Values the model may write itself, and the card marks as its own. */
export const INLINE_ROWS = 20;
export const INLINE_ITEMS = 12;
const AUTO_COLUMNS = 8;
const AUTO_FIELDS = 24;
const CELL_CHARS = 500;

type Cell = string | number | null;

export interface PresentedCard {
  presented: true;
  title: string;
  layout: 'table' | 'list' | 'stats' | 'detail';
  subtitle?: string;
  columns?: string[];
  rows?: Cell[][];
  items?: { label: string; value: string | number; hint?: string | undefined }[];
  /** `source`: taken from a read by the server. `agent`: written by the model. */
  origin: 'source' | 'agent';
  source?: { id: string; from: string; at: string };
  /** Lines or fields in the source, when it held more than the card shows. */
  total?: number;
  shown: number;
}

const field = z.string().trim().min(1).max(160);
const columnArg = z.union([
  z.string().trim().min(1).max(160),
  z.object({ field, label: z.string().trim().max(60).optional() }),
]);

export function presentTool(store: AgentStore): AgentTool {
  return tool({
    name: 'present',
    source: false,
    summary: 'Laid the answer out',
    description:
      'Show data to the person as a card — a table, a list, stat tiles or a detail sheet — instead of writing it out. ' +
      'Name the read it comes from by its "source" (every read answer has one): the server lays out the read’s own rows, ' +
      'all of them, and you choose which fields and how. Never retype rows you read. ' +
      `Only values you worked out yourself (a total, an average) go in rows or items — at most ${INLINE_ROWS} rows or ${INLINE_ITEMS} items — and the card marks them as yours. Changes nothing.`,
    schema: z
      .object({
        title: z.string().trim().min(1).max(120),
        layout: z.enum(['table', 'list', 'stats', 'detail']),
        subtitle: z.string().trim().max(240).optional(),
        source: z
          .string()
          .regex(SOURCE_ID, 'a source handle such as src-a1b2c3, from a read answer')
          .optional()
          .describe('The "source" of a read answer in this conversation. The card is built from it.'),
        path: z
          .string()
          .trim()
          .max(200)
          .optional()
          .describe(
            'Where in that answer: "rows", "items", "sheets.0". Omit for the first list in it (table, list) or the whole answer (stats, detail).',
          ),
        header: z
          .boolean()
          .optional()
          .describe('table, from lines that are lists of cells (an attached table): true when the first line names the columns.'),
        columns: z
          .array(columnArg)
          .max(12)
          .optional()
          .describe(
            'table: the fields to show, in order — "name" or { "field": "address.city", "label": "City" }. Omit for the first fields. Without a source: the column headings of your rows.',
          ),
        fields: z
          .array(z.object({ field, label: z.string().trim().max(60).optional(), hint: z.string().trim().max(160).optional() }))
          .max(AUTO_FIELDS)
          .optional()
          .describe('stats, detail, list from a source: which fields to show, each with an optional label and hint.'),
        rows: z
          .array(z.array(z.union([z.string().max(CELL_CHARS), z.number(), z.null()])).max(12))
          .max(INLINE_ROWS)
          .optional()
          .describe(`table, without a source: values you worked out — at most ${INLINE_ROWS} rows.`),
        items: z
          .array(
            z.object({
              label: z.string().max(120),
              value: z.union([z.string().max(CELL_CHARS), z.number()]),
              hint: z.string().max(160).optional(),
            }),
          )
          .max(INLINE_ITEMS)
          .optional()
          .describe(`list, stats, detail, without a source: values you worked out — at most ${INLINE_ITEMS}.`),
      })
      .refine((v) => !(v.source && (v.rows || v.items)), {
        message: 'Give either a source or values you worked out, not both',
      }),
    run: async (context, args): Promise<{ kind: 'data'; data: PresentedCard }> => {
      const head = {
        presented: true as const,
        title: args.title,
        layout: args.layout,
        ...(args.subtitle ? { subtitle: args.subtitle } : {}),
      };

      if (!args.source) {
        if (args.layout === 'table') {
          if (!args.rows?.length) throw new ToolError('Name a source to lay out, or give the rows you worked out.');
          const columns = (args.columns ?? []).map((c) => (typeof c === 'string' ? c : (c.label ?? c.field)));
          return { kind: 'data', data: { ...head, origin: 'agent', columns, rows: args.rows, shown: args.rows.length } };
        }
        if (!args.items?.length) throw new ToolError('Name a source to lay out, or give the items you worked out.');
        return { kind: 'data', data: { ...head, origin: 'agent', items: args.items, shown: args.items.length } };
      }

      const found = await store.run(context.principal, (client) =>
        store.source(client, context.conversationId, args.source!),
      );
      let kept: unknown;
      try {
        kept = found ? JSON.parse(found.content) : null;
      } catch {
        kept = null;
      }
      if (!found || !isSourceAnswer(kept)) {
        throw new ToolError(`No read answer with source ${args.source} in this conversation. Read it again, then present that.`);
      }
      const source = { id: kept.source, from: kept.from, at: found.created_at.toISOString() };
      const target = args.path ? at(kept.result, args.path) : undefined;
      if (args.path && target === undefined) {
        throw new ToolError(`Nothing at "${args.path}" in ${args.source}. Look at the answer’s fields and try again.`);
      }

      // A table needs a list; a list takes one when there is one, else a record's fields.
      const list =
        args.layout === 'table' || args.layout === 'list'
          ? args.path
            ? listAt(kept.result, args.path)
            : firstList(kept.result)
          : null;
      if (args.layout === 'table' && !list) {
        throw new ToolError(`${args.source} holds no list${args.path ? ` at "${args.path}"` : ''} to lay out as a table. Use stats or detail.`);
      }
      if (list && list.list.some((entry) => Array.isArray(entry))) {
        // Lines that are lists of cells — a table's rows: each line as it is, its own columns.
        const width = Math.min(12, Math.max(...list.list.map((e) => (Array.isArray(e) ? e.length : 1))));
        const asCells = (entry: unknown) => (Array.isArray(entry) ? entry.slice(0, width).map(cell) : [cell(entry)]);
        // The first line, when it names the columns, heads the card rather than filling it.
        const first = args.header ? asCells(list.list[0]) : [];
        const body = args.header ? list.list.slice(1) : list.list;
        const lines = body.slice(0, CARD_ROWS).map(asCells);
        const named = (args.columns ?? []).map((c) => (typeof c === 'string' ? c : (c.label ?? c.field)));
        const headings = Array.from({ length: width }, (_, i) => {
          const own = first[i];
          return named[i] ?? (own === undefined || own === null ? `Column ${i + 1}` : String(own));
        });
        const total = args.header ? list.total - 1 : list.total;
        const beyond = (shown: number) => (total > shown ? { total } : {});
        if (args.layout === 'list') {
          const items = lines.map((r) => ({ label: String(r[0] ?? ''), value: r.length > 1 ? (r[1] ?? '') : '' }));
          return {
            kind: 'data',
            data: { ...head, origin: 'source', source, items, shown: items.length, ...beyond(items.length) },
          };
        }
        const card = fitRows(lines, (rows) => ({
          ...head,
          origin: 'source' as const,
          source,
          columns: headings,
          rows,
          shown: rows.length,
          ...beyond(rows.length),
        }));
        return { kind: 'data', data: card };
      }
      if (list) {
        const columns = (args.columns ?? autoColumns(list.list)).map((c) =>
          typeof c === 'string' ? { field: c, label: labelOf(c) } : { field: c.field, label: c.label ?? labelOf(c.field) },
        );
        const lines = list.list.slice(0, CARD_ROWS).map((entry) =>
          entry !== null && typeof entry === 'object'
            ? columns.map((c) => cell(at(entry, c.field)))
            : [cell(entry)], // a list of plain values: one column
        );
        const headings = columns.length > 0 ? columns.map((c) => c.label) : ['Value'];
        const beyond = (shown: number) => (list.total > shown ? { total: list.total } : {});

        if (args.layout === 'list') {
          const items = lines.map((r) => ({ label: String(r[0] ?? ''), value: r.length > 1 ? (r[1] ?? '') : '' }));
          return {
            kind: 'data',
            data: { ...head, origin: 'source', source, items, shown: items.length, ...beyond(items.length) },
          };
        }
        const card = fitRows(lines, (rows) => ({
          ...head,
          origin: 'source' as const,
          source,
          columns: headings,
          rows,
          shown: rows.length,
          ...beyond(rows.length),
        }));
        return { kind: 'data', data: card };
      }

      const object = target ?? kept.result;
      if (!object || typeof object !== 'object' || Array.isArray(object)) {
        throw new ToolError(`${args.source}${args.path ? ` at "${args.path}"` : ''} is not a record of fields; lay a list out as a table.`);
      }
      const chosen =
        args.fields ??
        Object.entries(object as Record<string, unknown>)
          .filter(([, v]) => v === null || typeof v !== 'object')
          .slice(0, AUTO_FIELDS)
          .map(([key]) => ({ field: key, label: undefined, hint: undefined }));
      const items = chosen.map((f) => ({
        label: f.label ?? labelOf(f.field),
        value: cell(at(object, f.field)) ?? '—',
        ...(f.hint ? { hint: f.hint } : {}),
      }));
      if (items.length === 0) throw new ToolError(`Nothing to show in ${args.source}; name fields.`);
      return { kind: 'data', data: { ...head, origin: 'source', source, items, shown: items.length } };
    },
  });
}

// ──────────────────────────────────────────────────────────────── reading

/** The value at a dotted path — `summary.total`, `items.0.name`. */
export function at(value: unknown, path: string): unknown {
  let here: unknown = value;
  for (const key of path.split('.')) {
    if (here === null || typeof here !== 'object') return undefined;
    here = Array.isArray(here) ? here[Number(key)] : (here as Record<string, unknown>)[key];
  }
  return here;
}

interface Located {
  list: unknown[];
  /** How many the read said there are: a `total` beside the list, or what a shortened list counts. */
  total: number;
}

function located(list: unknown[], parent: unknown): Located {
  const closing = omittedOf(list.at(-1));
  const rows = closing ? list.slice(0, -1) : list;
  const said =
    parent && typeof parent === 'object' && !Array.isArray(parent)
      ? (parent as Record<string, unknown>)['total']
      : undefined;
  const total = Math.max(rows.length, closing?.all ?? 0, typeof said === 'number' ? said : 0);
  return { list: rows, total };
}

function listAt(value: unknown, path: string): Located | null {
  const target = at(value, path);
  if (!Array.isArray(target)) return null;
  const parentPath = path.split('.').slice(0, -1).join('.');
  return located(target, parentPath ? at(value, parentPath) : value);
}

/** The first list in an answer, breadth first — `items` before anything deeper. */
export function firstList(value: unknown): Located | null {
  if (Array.isArray(value)) return located(value, null);
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    for (const child of Object.values(node as Record<string, unknown>)) {
      if (Array.isArray(child) && child.some((c) => c !== null && typeof c === 'object')) return located(child, node);
    }
    for (const child of Object.values(node as Record<string, unknown>)) {
      if (child && typeof child === 'object' && !Array.isArray(child)) queue.push(child);
    }
  }
  return null;
}

/** A list's first fields that read as a cell — ids last, since a person reads names. */
function autoColumns(list: unknown[]): string[] {
  const first = list.find((e) => e !== null && typeof e === 'object' && !Array.isArray(e)) as Record<string, unknown> | undefined;
  if (!first) return [];
  const keys = Object.keys(first).filter((k) => {
    const v = first[k];
    return v === null || typeof v !== 'object';
  });
  const ordered = [...keys.filter((k) => !/(^id$|Id$|_id$)/.test(k)), ...keys.filter((k) => /(^id$|Id$|_id$)/.test(k))];
  return ordered.slice(0, AUTO_COLUMNS);
}

/** "fullName" → "Full name", "created_at" → "Created at". */
export function labelOf(path: string): string {
  const last = path.split('.').at(-1) ?? path;
  const words = last
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A value as a card's cell: numbers stay numbers; lists and records in words, briefly. */
export function cell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value.length > CELL_CHARS ? `${value.slice(0, CELL_CHARS)}…` : value;
  if (Array.isArray(value)) {
    const plain = value.filter((v) => v === null || typeof v !== 'object');
    return plain.length === value.length
      ? plain.map((v) => String(v ?? '')).join(', ').slice(0, CELL_CHARS)
      : `${value.length.toLocaleString('en-US')} items`;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['name', 'fullName', 'title', 'label']) {
    if (typeof record[key] === 'string') return record[key];
  }
  return JSON.stringify(value).slice(0, 200);
}

/** As many rows as a kept card may hold (STORED_CHARS), from the first. */
function fitRows(rows: Cell[][], card: (rows: Cell[][]) => PresentedCard): PresentedCard {
  let count = rows.length;
  for (;;) {
    const built = card(rows.slice(0, count));
    if (count === 0 || JSON.stringify(built).length <= STORED_CHARS) return built;
    count = Math.floor(count * 0.8);
  }
}
