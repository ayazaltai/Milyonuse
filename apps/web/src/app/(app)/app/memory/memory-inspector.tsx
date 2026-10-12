'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import {
  type Locale,
  MEMORY_LIMITS,
  MEMORY_TIERS,
  type MemoryItemView,
  type MemoryLedgerStatus,
  type MemoryListView,
  type MemoryRevocationPreview,
  type MemoryTier,
} from '@milyonuse/contracts';
import { Button, CellPair, Empty, Notice, PageHead, Panel, Table, Tag, Td, Th } from '@/components/ui/primitives';
import { type Dictionary, getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';
import { TrustBar, stateTone } from './memory-parts';
import { MemoryWhy } from './memory-why';

type View = 'active' | 'waiting' | 'demoted' | 'forget' | 'history' | 'all';
const VIEWS: View[] = ['active', 'waiting', 'demoted', 'forget', 'history', 'all'];

/** The list request a view makes; "gone" is three states, read together. */
function queriesFor(view: View, tier: MemoryTier | '', q: string): string[] {
  const common = new URLSearchParams();
  if (tier) common.set('tier', tier);
  if (q.trim()) common.set('q', q.trim());
  const withState = (state: string) => {
    const params = new URLSearchParams(common);
    params.set('state', state);
    return `/memory?${params.toString()}`;
  };
  switch (view) {
    case 'active':
      return [withState('active')];
    case 'waiting':
      return [withState('pending'), withState('t0_staged')];
    case 'demoted':
      return [withState('demoted')];
    case 'forget': {
      const params = new URLSearchParams(common);
      params.set('forget', 'requested');
      return [`/memory?${params.toString()}`];
    }
    case 'history':
      return [withState('rejected'), withState('revoked'), withState('expired')];
    case 'all':
      return [`/memory${common.size > 0 ? `?${common.toString()}` : ''}`];
  }
}

export function MemoryInspector({
  locale,
  initial,
  ledger: initialLedger,
}: {
  locale: Locale;
  initial: MemoryListView;
  ledger: MemoryLedgerStatus;
}) {
  const [ledger, setLedger] = useState(initialLedger);
  const t = getDictionary(locale);
  const m = t.app.memory;
  const [view, setView] = useState<View>('active');
  const [tier, setTier] = useState<MemoryTier | ''>('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<MemoryItemView[]>(initial.items);
  const [counts, setCounts] = useState(initial.counts);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const first = useRef(true);
  const date = new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-GB', { dateStyle: 'medium' });

  const load = useCallback(async () => {
    setLoading(true);
    const results = await Promise.all(queriesFor(view, tier, q).map((path) => request<MemoryListView>(path)));
    setLoading(false);
    const failed = results.find((r) => !r.ok);
    if (failed && !failed.ok) {
      setError(messageFor(failed.error, t));
      return;
    }
    const lists = results.map((r) => (r.ok ? r.data : null)).filter((r): r is MemoryListView => r !== null);
    setError(null);
    setItems(lists.flatMap((l) => l.items).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    if (lists[0]) setCounts(lists[0].counts);
    // Every change is a ledger entry: its count and integrity are read again with the list.
    const chain = await request<MemoryLedgerStatus>('/memory/ledger');
    if (chain.ok) setLedger(chain.data);
  }, [view, tier, q, t]);

  useEffect(() => {
    // The first view is the server's; a filter changed reads again, a little after the last keystroke.
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, q]);

  const waiting = (counts.pending ?? 0) + (counts.t0_staged ?? 0);

  return (
    <>
      <PageHead eyebrow={m.eyebrow} title={m.titleTop} accent={m.titleAccent} lead={m.lead} />

      <div className="flex flex-col gap-6">
        <div title={m.ledgerHint}>
          {ledger.intact ? (
            <Tag tone="pass">
              <ShieldCheck size={13} strokeWidth={2} style={{ verticalAlign: '-2px', marginRight: 6 }} />
              {m.ledgerIntact(ledger.checked)}
            </Tag>
          ) : (
            <Tag tone="danger">
              <ShieldAlert size={13} strokeWidth={2} style={{ verticalAlign: '-2px', marginRight: 6 }} />
              {m.ledgerBroken(ledger.brokenSeq ?? 0)}
            </Tag>
          )}
        </div>
        <AddMemory t={t} onAdded={() => void load()} />

        {waiting > 0 && view !== 'waiting' && (
          <Notice tone="review">
            <button type="button" className="link-button" onClick={() => setView('waiting')}>
              {m.needsYou(waiting)}
            </button>
          </Notice>
        )}

        <Panel
          flush
          actions={
            <Button size="sm" variant="ghost" onClick={() => setRevoking('')}>
              {m.revokeOpen}
            </Button>
          }
          title={m.title}
        >
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 12,
              alignItems: 'center',
              padding: '14px 24px',
              borderBottom: '1px solid var(--w-08)',
            }}
          >
            <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
              <div className="segmented" role="tablist" aria-label={m.title}>
                {VIEWS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="tab"
                    aria-selected={view === v}
                    className={`segmented-item${view === v ? ' segmented-item-active' : ''}`}
                    onClick={() => setView(v)}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    {m.views[v]}
                    {v === 'waiting' && waiting > 0 ? ` · ${waiting}` : ''}
                  </button>
                ))}
              </div>
            </div>
            <select
              className="control"
              aria-label={m.tierFilter}
              value={tier}
              onChange={(e) => setTier(e.target.value as MemoryTier | '')}
              style={{ width: 'auto' }}
            >
              <option value="">{m.anyTier}</option>
              {MEMORY_TIERS.map((x) => (
                <option key={x} value={x}>
                  {m.tiers[x]}
                </option>
              ))}
            </select>
            <input
              className="control"
              type="search"
              placeholder={m.search}
              aria-label={m.search}
              value={q}
              maxLength={200}
              onChange={(e) => setQ(e.target.value)}
              style={{ flex: '1 1 200px', width: 'auto' }}
            />
          </div>

          {error && (
            <div style={{ padding: '14px 24px 0' }}>
              <Notice tone="danger">{error}</Notice>
            </div>
          )}

          {items.length === 0 ? (
            <Empty title={m.empty} description={m.emptyHint} />
          ) : (
            <div aria-busy={loading} style={loading ? { opacity: 0.6 } : undefined}>
              <Table>
                <thead>
                  <tr>
                    <Th>{m.columns.memory}</Th>
                    <Th>{m.columns.tier}</Th>
                    <Th>{m.columns.trust}</Th>
                    <Th>{m.columns.state}</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <Td>
                        <CellPair
                          title={item.content}
                          sub={
                            <>
                              {item.operator ? m.operator : m.sources[item.sourceKind]} · {date.format(new Date(item.createdAt))}
                              {item.sensitivity === 'sensitive' ? ` · ${m.sensitive}` : ''}
                              {item.forgetRequestedAt ? ` · ${m.views.forget}` : ''}
                            </>
                          }
                        />
                      </Td>
                      <Td nowrap>
                        <Tag tone={item.tier === 'T0' ? 'brand' : 'neutral'}>{m.tiers[item.tier]}</Tag>
                        {(item.teamId || item.agentId) && (
                          <span title={m.scopeHint} style={{ marginLeft: 6 }}>
                            <Tag tone="brand">{item.teamId ? m.teamScope : m.agentScope}</Tag>
                          </span>
                        )}
                      </Td>
                      <Td>
                        <TrustBar trust={item.trust} label={m.trustOf(item.trust.toFixed(2))} />
                      </Td>
                      <Td nowrap>
                        <Tag tone={stateTone(item.state)}>{m.states[item.state]}</Tag>
                      </Td>
                      <Td nowrap>
                        <Button size="sm" variant="ghost" onClick={() => setOpen(item.id)}>
                          {m.why}
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </Panel>
      </div>

      {open && (
        <MemoryWhy
          locale={locale}
          memoryId={open}
          onClose={() => setOpen(null)}
          onChanged={() => void load()}
          onWithdraw={(uri) => {
            setOpen(null);
            setRevoking(uri);
          }}
        />
      )}
      {revoking !== null && (
        <RevokeSource t={t} initialUri={revoking} onClose={() => setRevoking(null)} onRevoked={() => void load()} />
      )}
    </>
  );
}

/** The person adds a memory in their own words — checked like any other, and said back plainly when refused. */
function AddMemory({ t, onAdded }: { t: Dictionary; onAdded: () => void }) {
  const m = t.app.memory;
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'pass' | 'danger'; text: string } | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!content.trim()) return;
    setBusy(true);
    setResult(null);
    const response = await request<MemoryItemView>('/memory', {
      method: 'POST',
      body: JSON.stringify({ content }),
      headers: { 'idempotency-key': crypto.randomUUID() },
    });
    setBusy(false);
    if (response.ok) {
      setContent('');
      setResult({ tone: 'pass', text: m.added });
      onAdded();
    } else if (response.error.code === 'conflict') {
      // The pipeline's own reason: "Not kept: scanner flagged …" — the person should see why.
      setResult({ tone: 'danger', text: response.error.message || m.notKept('') });
    } else {
      setResult({ tone: 'danger', text: messageFor(response.error, t) });
    }
  }

  return (
    <Panel title={m.addTitle}>
      <form onSubmit={(e) => void submit(e)} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <textarea
          className="control"
          rows={2}
          value={content}
          maxLength={MEMORY_LIMITS.contentChars}
          placeholder={m.addPlaceholder}
          aria-label={m.addTitle}
          onChange={(e) => setContent(e.target.value)}
          style={{ flex: '1 1 320px', width: 'auto', resize: 'vertical' }}
        />
        <Button type="submit" variant="primary" disabled={busy || !content.trim()}>
          {busy ? m.adding : m.add}
        </Button>
      </form>
      {result && (
        <div style={{ marginTop: 12 }}>
          <Notice tone={result.tone}>{result.text}</Notice>
        </div>
      )}
    </Panel>
  );
}

/** Withdrawing a source: first what it would take, then the one action that takes it. */
function RevokeSource({
  t,
  initialUri,
  onClose,
  onRevoked,
}: {
  t: Dictionary;
  initialUri: string;
  onClose: () => void;
  onRevoked: () => void;
}) {
  const m = t.app.memory;
  const dialog = useRef<HTMLDialogElement>(null);
  const [uri, setUri] = useState(initialUri);
  const [preview, setPreview] = useState<MemoryRevocationPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'pass' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const look = useCallback(
    async (source: string) => {
      if (!source.trim()) return;
      setBusy(true);
      setMessage(null);
      const response = await request<MemoryRevocationPreview>(
        `/memory/revocations/preview?sourceUri=${encodeURIComponent(source.trim())}`,
      );
      setBusy(false);
      if (response.ok) setPreview(response.data);
      else setMessage({ tone: 'danger', text: messageFor(response.error, t) });
    },
    [t],
  );

  useEffect(() => {
    if (initialUri) void look(initialUri);
  }, [initialUri, look]);

  async function revoke(): Promise<void> {
    if (!preview) return;
    setBusy(true);
    const response = await request<{ revoked: string[] }>('/memory/revocations', {
      method: 'POST',
      body: JSON.stringify({ sourceUri: preview.sourceUri }),
    });
    setBusy(false);
    if (!response.ok) {
      setMessage({ tone: 'danger', text: messageFor(response.error, t) });
      return;
    }
    setMessage({ tone: 'pass', text: m.revoked(response.data.revoked.length) });
    setPreview(null);
    onRevoked();
  }

  return (
    <dialog ref={dialog} className="dialog" onClose={onClose} aria-labelledby="revoke-title">
      <div className="dialog-head">
        <div>
          <p className="eyebrow">{m.title}</p>
          <h2 id="revoke-title" className="dialog-title">
            {m.revokeTitle}
          </h2>
        </div>
        <Button size="sm" variant="ghost" onClick={() => dialog.current?.close()}>
          {m.close}
        </Button>
      </div>
      <p style={{ fontSize: 13.5, color: 'var(--w-60)', lineHeight: 1.6, margin: '0 0 16px' }}>{m.revokeLead}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void look(uri);
        }}
        style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}
      >
        <input
          className="control"
          aria-label={m.sourceLabel}
          placeholder={m.sourcePlaceholder}
          value={uri}
          maxLength={2000}
          onChange={(e) => {
            setUri(e.target.value);
            setPreview(null);
          }}
          style={{ flex: '1 1 260px', width: 'auto' }}
        />
        <Button type="submit" disabled={busy || !uri.trim()}>
          {busy && !preview ? m.previewing : m.preview}
        </Button>
      </form>

      {preview && (
        <div style={{ marginTop: 18 }}>
          <p style={{ fontSize: 13.5, margin: '0 0 10px' }}>{m.willTake(preview.items.length)}</p>
          {preview.items.length > 0 && (
            <ul style={{ margin: 0, padding: '0 0 0 18px', display: 'grid', gap: 6, fontSize: 13.5, color: 'var(--w-80)' }}>
              {preview.items.map((item) => (
                <li key={item.id}>
                  {item.content} <span style={{ color: 'var(--w-35)' }}>· {m.states[item.state]}</span>
                </li>
              ))}
            </ul>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
            <Button variant="ghost" onClick={() => dialog.current?.close()}>
              {m.cancel}
            </Button>
            <Button variant="danger" disabled={busy || preview.items.length === 0} onClick={() => void revoke()}>
              {m.revoke}
            </Button>
          </div>
        </div>
      )}
      {message && (
        <div style={{ marginTop: 14 }}>
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      )}
    </dialog>
  );
}
