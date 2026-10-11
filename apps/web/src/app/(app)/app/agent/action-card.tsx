'use client';

import { useEffect, useState } from 'react';
import type { AgentActionView, Locale } from '@milyonuse/contracts';
import { getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';

/** The action a tool answer names — `{ "actionId": … }` — or null for any other answer. */
export function actionIdOf(content: string): string | null {
  if (!content.startsWith('{') || !content.includes('"actionId"')) return null;
  try {
    const parsed = JSON.parse(content) as { actionId?: unknown };
    return typeof parsed.actionId === 'string' ? parsed.actionId : null;
  } catch {
    return null;
  }
}

/** Files an action's result names, to download. */
function filesOf(action: AgentActionView): { name: string; url: string }[] {
  const data = (action.result?.['data'] ?? null) as {
    files?: { name: string; url: string }[];
    file?: { name: string; url: string };
  } | null;
  return [...(data?.files ?? []), ...(data?.file ? [data.file] : [])].filter(
    (f) => typeof f.url === 'string' && f.url.startsWith('/api/v1/agent/files/'),
  );
}

/**
 * A proposal, as the person decides on it (F3 §1): what will happen in their
 * terms — to whom, when, the message or the code itself — whether it can be
 * taken back, and the one button that runs it. Once run: what came of it,
 * and an undo where there is one. A running batch reads its progress until
 * it finishes.
 */
export function ActionCard({
  locale,
  action,
  onChange,
}: {
  locale: Locale;
  action: AgentActionView;
  onChange: (action: AgentActionView) => void;
}) {
  const t = getDictionary(locale);
  const a = t.app.agent.action;
  const [busy, setBusy] = useState<'confirm' | 'discard' | 'undo' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // A batch running in the queue: read it again until it ends.
  useEffect(() => {
    if (action.status !== 'running') return;
    const timer = setInterval(() => {
      void request<AgentActionView>(`/agent/actions/${action.id}`).then((r) => {
        if (r.ok && (r.data.status !== action.status || r.data.processed !== action.processed)) onChange(r.data);
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [action.id, action.status, action.processed, onChange]);

  async function decide(verb: 'confirm' | 'discard' | 'undo'): Promise<void> {
    setBusy(verb);
    setError(null);
    const response = await request<AgentActionView>(`/agent/actions/${action.id}/${verb}`, {
      method: 'POST',
      body: JSON.stringify({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    });
    setBusy(null);
    if (!response.ok) {
      setError(messageFor(response.error, t));
      return;
    }
    // An undo answers a new card; the old one is refreshed so it no longer offers one.
    if (verb === 'undo') {
      onChange(response.data);
      const fresh = await request<AgentActionView>(`/agent/actions/${action.id}`);
      if (fresh.ok) onChange(fresh.data);
    } else {
      onChange(response.data);
    }
  }

  const p = action.preview;
  const hours = Math.max(1, Math.round((Date.parse(action.expiresAt) - Date.now()) / 3_600_000));
  const body = p.body ?? null;
  const long = body !== null && body.length > 600;
  const files = filesOf(action);
  const printed = (action.result?.['data'] as { stdout?: unknown; stderr?: unknown } | null) ?? null;
  const output =
    action.status === 'completed' && printed
      ? [printed.stdout, printed.stderr].filter((x): x is string => typeof x === 'string' && x.trim() !== '').join('\n')
      : '';
  const tone = action.status === 'completed' ? 'pass' : action.status === 'failed' ? 'danger' : undefined;
  const note =
    error ??
    (action.status === 'proposed'
      ? [!action.reversible ? a.irreversible : null, a.expiresIn(hours)].filter(Boolean).join(' · ')
      : action.status === 'failed'
        ? action.error
        : action.status === 'running' || action.itemCount > 1
          ? [a.progress(action.processed, action.itemCount), a.partial(action.failed, action.uncertain)]
              .filter(Boolean)
              .join(' · ')
          : action.autoConfirmed && action.status === 'completed'
            ? a.autoRan
            : null);

  return (
    <section className="agent-action" data-status={action.status} data-risk={action.risk} aria-label={p.title}>
      <header className="agent-action-head">
        <div style={{ minWidth: 0 }}>
          <p className="agent-action-title">{p.title}</p>
          {(p.summary || action.connection || action.undoOf) && (
            <p className="agent-action-sub">
              {[action.undoOf ? a.undoOf : null, p.summary, action.connection ? a.through(action.connection.name) : null]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
        <span className={`tag${action.status === 'proposed' ? ' tag-brand' : tone ? ` tag-${tone}` : ''}`}>
          {a.statuses[action.status]}
        </span>
      </header>

      {p.fields && p.fields.length > 0 && (
        <dl className="agent-action-fields">
          {p.fields.map((f) => (
            <div key={f.label} style={{ display: 'contents' }}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {body !== null && (
        <>
          <pre className="agent-action-body">{long && !open ? `${body.slice(0, 600)}…` : body}</pre>
          {long && (
            <div style={{ padding: '0 16px 8px' }}>
              <button type="button" className="agent-link" onClick={() => setOpen((v) => !v)}>
                {open ? a.showLess : a.showMore}
              </button>
            </div>
          )}
        </>
      )}
      {p.table && (
        <div className="agent-data-table-wrap" style={{ margin: '0 16px 10px' }}>
          <table className="agent-data-table">
            <thead>
              <tr>
                {p.table.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {p.table.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {p.warnings?.map((w) => (
        <p key={w} className="agent-action-warning">
          {w}
        </p>
      ))}
      {action.itemCount > 1 && action.status !== 'proposed' && (
        <div
          className="agent-action-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={action.itemCount}
          aria-valuenow={action.processed}
        >
          <span style={{ width: `${Math.round((action.processed / action.itemCount) * 100)}%` }} />
        </div>
      )}
      {output && <pre className="agent-action-body">{output}</pre>}
      {files.length > 0 && (
        <div className="agent-action-files">
          {files.map((f) => (
            <a key={f.url} className="agent-chip" href={f.url} download>
              {f.name}
            </a>
          ))}
        </div>
      )}

      {(note || action.status === 'proposed' || action.undoable) && (
        <footer className="agent-action-foot">
          <span className="agent-action-note" data-tone={error ? 'danger' : tone}>
            {note}
          </span>
          <span className="agent-action-buttons">
            {action.status === 'proposed' && (
              <>
                <button type="button" className="agent-ghost" disabled={busy !== null} onClick={() => void decide('discard')}>
                  {a.discard}
                </button>
                <button
                  type="button"
                  className="agent-ghost"
                  data-variant="outline"
                  disabled={busy !== null}
                  onClick={() => void decide('confirm')}
                >
                  {busy === 'confirm' ? a.confirming : a.confirm}
                </button>
              </>
            )}
            {action.undoable && (
              <button type="button" className="agent-ghost" disabled={busy !== null} onClick={() => void decide('undo')}>
                {busy === 'undo' ? a.undoing : a.undo}
              </button>
            )}
          </span>
        </footer>
      )}
    </section>
  );
}
