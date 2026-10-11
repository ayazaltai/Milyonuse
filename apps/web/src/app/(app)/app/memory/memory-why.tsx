'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Locale, MemoryDetailView, MemoryItemView } from '@milyonuse/contracts';
import { Button, Notice, Tag } from '@/components/ui/primitives';
import { getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';
import { TrustBar, stateTone } from './memory-parts';

type Action = 'approve' | 'reaffirm' | 'forget' | 'keep';

/**
 * "Why does the agent know this?" — one memory's provenance, evidence,
 * history and what hangs on it, with the decisions that are the person's:
 * approve what waits for them, reaffirm, forget (and what is built on it),
 * keep what the agent asked to forget, withdraw the source it came from.
 */
export function MemoryWhy({
  locale,
  memoryId,
  onClose,
  onChanged,
  onWithdraw,
}: {
  locale: Locale;
  memoryId: string;
  onClose: () => void;
  onChanged: () => void;
  onWithdraw: (sourceUri: string) => void;
}) {
  const t = getDictionary(locale);
  const m = t.app.memory;
  const dialog = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<MemoryDetailView | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ tone: 'pass' | 'danger'; text: string } | null>(null);
  const when = new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });

  const load = useCallback(async () => {
    const response = await request<MemoryDetailView>(`/memory/${memoryId}`);
    if (response.ok) setDetail(response.data);
    else setMessage({ tone: 'danger', text: messageFor(response.error, t) });
  }, [memoryId, t]);

  useEffect(() => {
    dialog.current?.showModal();
    void load();
  }, [load]);

  async function act(action: Action): Promise<void> {
    setBusy(action);
    setMessage(null);
    const response = await request<MemoryItemView | { revoked: string[] }>(`/memory/${memoryId}/${action}`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    setBusy(null);
    setConfirming(false);
    if (!response.ok) {
      setMessage({ tone: 'danger', text: messageFor(response.error, t) });
      return;
    }
    setMessage({ tone: 'pass', text: action === 'reaffirm' ? m.reaffirmed : m.done });
    onChanged();
    await load();
  }

  const item = detail?.item;
  const live = item && (item.state === 'active' || item.state === 'demoted' || item.state === 'pending');

  return (
    <dialog
      ref={dialog}
      className="dialog"
      onClose={onClose}
      aria-labelledby="why-title"
      style={{ width: 'min(680px, calc(100vw - 32px))' }}
    >
      <div className="dialog-head">
        <div>
          <p className="eyebrow">{m.title}</p>
          <h2 id="why-title" className="dialog-title">
            {m.whyTitle}
          </h2>
        </div>
        <Button size="sm" variant="ghost" onClick={() => dialog.current?.close()}>
          {m.close}
        </Button>
      </div>

      {!item ? (
        message ? <Notice tone="danger">{message.text}</Notice> : <div className="skeleton-line" style={{ height: 60 }} />
      ) : (
        <div style={{ display: 'grid', gap: 20 }}>
          <div>
            <p style={{ fontSize: 16, lineHeight: 1.55, margin: 0 }}>{item.content}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12, alignItems: 'center' }}>
              <Tag tone={item.tier === 'T0' ? 'brand' : 'neutral'}>{m.tiers[item.tier]}</Tag>
              <Tag tone={stateTone(item.state)}>{m.states[item.state]}</Tag>
              {item.sensitivity === 'sensitive' && <Tag tone="review">{m.sensitive}</Tag>}
              <span style={{ flex: '1 1 160px', maxWidth: 220 }}>
                <TrustBar trust={item.trust} label={m.trustOf(item.trust.toFixed(2))} />
              </span>
            </div>
            {item.forgetRequestedAt && (
              <div style={{ marginTop: 12 }}>
                <Notice tone="review">{m.forgetAsked(item.forgetReason ?? '')}</Notice>
              </div>
            )}
            {item.flaggedWith && (
              <div style={{ marginTop: 12 }}>
                <Notice tone="review">{m.flagged}</Notice>
              </div>
            )}
          </div>

          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '8px 18px', margin: 0, fontSize: 13.5 }}>
            <Fact label={m.facts.source}>{item.operator ? m.operator : m.sources[item.sourceKind]}</Fact>
            {item.sourceUri && <Fact label={m.facts.from}>{item.sourceUri}</Fact>}
            <Fact label={m.facts.by}>
              {item.actor === 'agent' ? m.agentActor : item.actor.startsWith('member:') ? m.youActor : item.actor}
            </Fact>
            <Fact label={m.facts.created}>{when.format(new Date(item.createdAt))}</Fact>
            {item.verifiedAt && <Fact label={m.facts.verified}>{when.format(new Date(item.verifiedAt))}</Fact>}
            {item.expiresAt && <Fact label={m.facts.expires}>{when.format(new Date(item.expiresAt))}</Fact>}
            <Fact label={m.facts.ceiling}>{item.trustCeiling.toFixed(2)}</Fact>
            {item.reaffirmCount > 0 && <Fact label={m.facts.reaffirmed}>{m.times(item.reaffirmCount)}</Fact>}
            {(item.tier === 'T3' || detail.confirmations.length > 0) && (
              <Fact label={m.facts.confirmations}>
                {detail.confirmations.length === 0
                  ? '0'
                  : detail.confirmations.map((c) => c.sourceUri ?? m.sources[c.sourceKind]).join(' · ')}
              </Fact>
            )}
            {item.stateReason && <Fact label={m.facts.reason}>{item.stateReason}</Fact>}
            {item.verdict && item.verdict !== item.stateReason && <Fact label={m.facts.verdict}>{item.verdict}</Fact>}
          </dl>

          {(detail.derivedFrom.sourceUris.length > 0 || detail.derivedFrom.memories.length > 0) && (
            <Section title={m.derivedFrom}>
              {detail.derivedFrom.sourceUris.map((uri) => (
                <li key={uri}>{uri}</li>
              ))}
              {detail.derivedFrom.memories.map((parent) => (
                <li key={parent.id}>{parent.content}</li>
              ))}
            </Section>
          )}

          <Section title={m.derivatives}>
            {detail.derivatives.length === 0 ? (
              <li style={{ listStyle: 'none', marginLeft: -18, color: 'var(--w-35)' }}>{m.derivativesNone}</li>
            ) : (
              detail.derivatives.map((child) => (
                <li key={child.id}>
                  {child.content} <span style={{ color: 'var(--w-35)' }}>· {m.states[child.state]}</span>
                </li>
              ))
            )}
          </Section>

          <Section title={m.ledger}>
            {detail.ledger.map((entry) => (
              <li key={entry.seq} style={{ listStyle: 'none', marginLeft: -18, display: 'flex', gap: 12, alignItems: 'baseline' }}>
                <span style={{ color: 'var(--w-35)', fontVariantNumeric: 'tabular-nums', minWidth: 150 }}>
                  {when.format(new Date(entry.createdAt))}
                </span>
                <span style={{ flex: 1 }}>{(m.ledgerActions as Record<string, string>)[entry.action] ?? entry.action}</span>
                <span title={entry.entryHash} style={{ color: 'var(--w-35)', fontSize: 12 }}>
                  #{entry.seq} · {entry.entryHash.slice(0, 8)}
                </span>
              </li>
            ))}
          </Section>

          {message && <Notice tone={message.tone}>{message.text}</Notice>}

          {item.operator ? (
            <Notice>{m.operatorNote}</Notice>
          ) : confirming ? (
            <div style={{ display: 'grid', gap: 12 }}>
              <Notice tone="review">{m.forgetConfirm(detail.derivatives.filter((d) => d.state !== 'revoked').length)}</Notice>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <Button variant="ghost" onClick={() => setConfirming(false)}>
                  {m.cancel}
                </Button>
                <Button variant="danger" disabled={busy !== null} onClick={() => void act('forget')}>
                  {m.forget}
                </Button>
              </div>
            </div>
          ) : (
            live && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'flex-end' }}>
                {item.sourceUri && (
                  <Button variant="ghost" onClick={() => onWithdraw(item.sourceUri!)}>
                    {m.withdrawSource}
                  </Button>
                )}
                {item.forgetRequestedAt && (
                  <Button disabled={busy !== null} onClick={() => void act('keep')}>
                    {m.keep}
                  </Button>
                )}
                <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirming(true)}>
                  {m.forget}
                </Button>
                {(item.state === 'active' || item.state === 'demoted') && (
                  <Button disabled={busy !== null} onClick={() => void act('reaffirm')}>
                    {m.reaffirm}
                  </Button>
                )}
                {item.state === 'pending' && item.tier === 'T4' && (
                  <Button variant="primary" disabled={busy !== null} onClick={() => void act('approve')}>
                    {m.approve}
                  </Button>
                )}
              </div>
            )
          )}
        </div>
      )}
    </dialog>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt style={{ color: 'var(--w-50)' }}>{label}</dt>
      <dd style={{ margin: 0, color: 'var(--w-80)', overflowWrap: 'anywhere' }}>{children}</dd>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="eyebrow" style={{ marginBottom: 10 }}>
        {title}
      </p>
      <ul style={{ margin: 0, padding: '0 0 0 18px', display: 'grid', gap: 6, fontSize: 13.5, color: 'var(--w-80)' }}>
        {children}
      </ul>
    </div>
  );
}
