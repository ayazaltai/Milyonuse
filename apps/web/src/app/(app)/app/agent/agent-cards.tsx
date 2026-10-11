'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentMessageView, Locale } from '@milyonuse/contracts';
import { getDictionary } from '@/i18n';

/**
 * The agent's work as cards (ported from App-Milyonus
 * `(dashboard)/agent/agent-cards.tsx`): the steps it took and how it
 * reasoned, the data it laid out with `present`, and the reader's own way of
 * seeing them — kept in this browser only.
 */

// ─────────────────────────────────────────────────────────── personalisation

export interface AgentView {
  density: 'comfortable' | 'compact';
  steps: 'open' | 'folded';
  raw: boolean;
  /** Data cards the reader folded, by message id. */
  folded: string[];
  /** Data cards the reader pinned above the thread, by message id. */
  pinned: string[];
}

const DEFAULT_VIEW: AgentView = { density: 'comfortable', steps: 'folded', raw: false, folded: [], pinned: [] };
const VIEW_KEY = 'milyonuse.agent.view';

export function useAgentView(): [AgentView, (change: Partial<AgentView>) => void] {
  const [view, setView] = useState<AgentView>(DEFAULT_VIEW);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VIEW_KEY);
      if (saved) setView({ ...DEFAULT_VIEW, ...(JSON.parse(saved) as Partial<AgentView>) });
    } catch {
      // No storage here — the defaults serve.
    }
  }, []);
  const change = (next: Partial<AgentView>) =>
    setView((v) => {
      const merged = { ...v, ...next };
      try {
        window.localStorage.setItem(VIEW_KEY, JSON.stringify(merged));
      } catch {
        // Not kept; this visit still sees it.
      }
      return merged;
    });
  return [view, change];
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

export function ViewMenu({
  locale,
  view,
  onChange,
}: {
  locale: Locale;
  view: AgentView;
  onChange: (c: Partial<AgentView>) => void;
}) {
  const v = getDictionary(locale).app.agent.view;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <div className="agent-view" ref={root}>
      <button type="button" className="agent-ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {v.button}
      </button>
      {open && (
        <div className="agent-view-panel" role="dialog" aria-label={v.aria}>
          <Choice
            label={v.density}
            value={view.density}
            options={[
              ['comfortable', v.comfortable],
              ['compact', v.compact],
            ]}
            onChange={(density) => onChange({ density })}
          />
          <Choice
            label={v.steps}
            value={view.steps}
            options={[
              ['open', v.open],
              ['folded', v.folded],
            ]}
            onChange={(steps) => onChange({ steps })}
          />
          <Choice
            label={v.data}
            value={view.raw ? 'raw' : 'cards'}
            options={[
              ['cards', v.cards],
              ['raw', v.raw],
            ]}
            onChange={(next) => onChange({ raw: next === 'raw' })}
          />
          {view.pinned.length > 0 && (
            <button type="button" className="agent-view-reset" onClick={() => onChange({ pinned: [] })}>
              {v.unpinAll}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <div className="agent-view-row">
      <span>{label}</span>
      <div className="agent-segment" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── the steps

export interface LiveStep {
  summary: string;
  done: boolean;
}

/** How the agent got here: its reasoning, then each tool it used — live while it works. */
export function StepsCard({
  locale,
  reasoning,
  steps,
  live = false,
  defaultOpen,
}: {
  locale: Locale;
  reasoning: string | null;
  steps: LiveStep[];
  live?: boolean;
  defaultOpen: boolean;
}) {
  const a = getDictionary(locale).app.agent;
  const [open, setOpen] = useState(defaultOpen || live);
  useEffect(() => setOpen(defaultOpen || live), [defaultOpen, live]);
  // A box for the steps the agent took — none taken, none shown, reasoning or not.
  if (steps.length === 0) return null;
  const title = live ? a.working : `${a.steps(steps.length)}${reasoning ? a.withReasoning : ''}`;
  return (
    <div className="agent-steps" data-live={live || undefined}>
      <button type="button" className="agent-steps-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="agent-steps-title">{title}</span>
        <span className="agent-steps-fold">{open ? a.hide : a.show}</span>
      </button>
      {open && (
        <div className="agent-steps-body">
          {reasoning && <p className="agent-steps-reasoning">{reasoning}</p>}
          <ol className="agent-steps-list">
            {steps.map((s, i) => (
              <li key={`${s.summary}-${i}`} data-done={s.done || undefined}>
                {s.summary}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────── the data

type Cell = string | number | null;

interface Presented {
  presented: true;
  title: string;
  layout: 'table' | 'list' | 'stats' | 'detail';
  subtitle?: string;
  columns?: string[];
  rows?: Cell[][];
  items?: { label: string; value: string | number; hint?: string }[];
  /** `source`: the server laid it out from a read's own answer. `agent`: the model wrote the values. */
  origin?: 'source' | 'agent';
  source?: { id: string; from: string; at: string };
  /** What the source held, when the card shows less. */
  total?: number;
  shown?: number;
}

/** A `present` answer, when a tool message is one. */
export function presentedOf(message: AgentMessageView): Presented | null {
  if (message.role !== 'tool' || message.toolName !== 'present') return null;
  try {
    const data = JSON.parse(message.content) as Presented;
    return data.presented ? data : null;
  } catch {
    return null;
  }
}

/**
 * A value as a person reads it: a tool answers times as ISO 8601; the card
 * says them in the reader's own zone. CSV keeps the exact values. Only once
 * in the browser (`local`): the server's zone is not the reader's, and the
 * first render must match the server's.
 */
function display(value: Cell, local: boolean, locale: Locale): string {
  if (value === null) return '';
  if (typeof value === 'number' || !local) return String(value);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const at = new Date(value);
    return Number.isNaN(at.getTime())
      ? value
      : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const at = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(at.getTime())
      ? value
      : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(at);
  }
  return value;
}

function csvOf(columns: string[], rows: Cell[][]): string {
  const cell = (v: Cell) => {
    const s = v === null ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns, ...rows].map((r) => r.map(cell).join(',')).join('\n');
}

export function DataCard({
  locale,
  id,
  data,
  view,
  onView,
}: {
  locale: Locale;
  id: string;
  data: Presented;
  view: AgentView;
  onView: (c: Partial<AgentView>) => void;
}) {
  const c = getDictionary(locale).app.agent.card;
  const [query, setQuery] = useState('');
  const [local, setLocal] = useState(false);
  useEffect(() => setLocal(true), []);
  const [copied, setCopied] = useState(false);
  const folded = view.folded.includes(id);
  const pinned = view.pinned.includes(id);
  const columns = data.columns ?? [];
  const rows = useMemo(() => {
    const all = data.rows ?? [];
    const q = query.trim().toLocaleLowerCase(locale);
    return q
      ? all.filter((r) => r.some((value) => display(value, local, locale).toLocaleLowerCase(locale).includes(q)))
      : all;
  }, [data.rows, query, local, locale]);
  const items = data.items ?? [];
  const number = new Intl.NumberFormat(locale);

  // Where a card's values came from, in a line under its title.
  const fromSource = data.origin === 'source' && data.source;
  let origin = c.written;
  if (fromSource && data.source) {
    const at =
      !local || Number.isNaN(Date.parse(data.source.at))
        ? ''
        : ` · ${new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(data.source.at))}`;
    const shown = data.shown ?? data.rows?.length ?? data.items?.length ?? 0;
    const part =
      data.total !== undefined && data.total > shown ? c.showing(number.format(shown), number.format(data.total)) : '';
    origin = `${c.from(data.source.from.replace(/\.$/, ''))}${at}${part}`;
  }

  const asCsv = () =>
    data.layout === 'table'
      ? csvOf(columns, data.rows ?? [])
      : csvOf(
          [c.label, c.value],
          items.map((i) => [i.label, i.value]),
        );

  async function copy() {
    try {
      await navigator.clipboard.writeText(asCsv());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // The clipboard is not ours here; the download still works.
    }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([asCsv()], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${data.title.replace(/[^\p{L}\p{N}\- ]+/gu, '').trim() || 'data'}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section
      className="agent-data"
      data-layout={data.layout}
      data-pinned={pinned || undefined}
      data-origin={fromSource ? 'source' : 'agent'}
    >
      <header className="agent-data-head">
        <div>
          <h3 className="agent-data-title">{data.title}</h3>
          {data.subtitle && <p className="agent-data-sub">{data.subtitle}</p>}
          <p className="agent-data-origin">{origin}</p>
        </div>
        <div className="agent-data-tools">
          {data.layout === 'table' && !folded && (data.rows?.length ?? 0) > 8 && (
            <input
              className="agent-data-search"
              placeholder={c.filter}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={c.filterAria}
            />
          )}
          <button type="button" className="agent-ghost" onClick={() => void copy()}>
            {copied ? c.copied : c.copy}
          </button>
          <button type="button" className="agent-ghost" onClick={download}>
            {c.csv}
          </button>
          <button type="button" className="agent-ghost" onClick={() => onView({ pinned: toggle(view.pinned, id) })}>
            {pinned ? c.unpin : c.pin}
          </button>
          <button type="button" className="agent-ghost" onClick={() => onView({ folded: toggle(view.folded, id) })}>
            {folded ? c.open : c.fold}
          </button>
        </div>
      </header>
      {!folded && (
        <div className="agent-data-body">
          {data.layout === 'table' && (
            <div className="agent-data-table-wrap">
              <table className="agent-data-table">
                <thead>
                  <tr>
                    {columns.map((column, j) => (
                      <th key={`${column}-${j}`}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      {r.map((value, j) => (
                        <td key={j}>{display(value, local, locale)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length === 0 && <p className="agent-data-empty">{c.nothingMatches}</p>}
            </div>
          )}
          {data.layout === 'stats' && (
            <div className="agent-data-stats">
              {items.map((i) => (
                <div key={i.label} className="agent-data-stat">
                  <span className="agent-data-stat-value">{display(i.value, local, locale)}</span>
                  <span className="agent-data-stat-label">{i.label}</span>
                  {i.hint && <span className="agent-data-hint">{i.hint}</span>}
                </div>
              ))}
            </div>
          )}
          {(data.layout === 'list' || data.layout === 'detail') && (
            <dl className="agent-data-list">
              {items.map((i, index) => (
                <div key={`${i.label}-${index}`}>
                  <dt>{i.label}</dt>
                  <dd>
                    {display(i.value, local, locale)}
                    {i.hint && <span className="agent-data-hint">{i.hint}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {view.raw && <pre className="agent-data-raw">{JSON.stringify(data, null, 2)}</pre>}
        </div>
      )}
    </section>
  );
}
