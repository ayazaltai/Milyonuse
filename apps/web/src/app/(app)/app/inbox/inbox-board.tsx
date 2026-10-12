'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AutomationDraftView, AutomationView, InboxView, Locale, StudioAgentView, TeamView } from '@milyonuse/contracts';
import { Button, Checkbox, Empty, Notice, PageHead, Panel, Tag } from '@/components/ui/primitives';
import { getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';
import { AutomationForm } from '../automations/automation-form';
import { runTone } from '../teams/[teamId]/team-detail';

type Bulk = { results: { id: string; status: string | null; error: string | null }[] };

/**
 * Everything waiting for the person. Proposals are answered together or one
 * by one — each still goes through its own confirmation on the server; the
 * rest link to where they are answered, or are marked done here.
 */
export function InboxBoard({
  locale,
  initial,
  agents,
  teams,
  automations,
}: {
  locale: Locale;
  initial: InboxView;
  agents: StudioAgentView[];
  teams: TeamView[];
  automations: AutomationView[];
}) {
  const t = getDictionary(locale);
  const k = t.app.inbox;
  const router = useRouter();
  const [inbox, setInbox] = useState(initial);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [making, setMaking] = useState<{ itemId: string; draft: AutomationDraftView } | null>(null);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  const empty = inbox.proposals.length + inbox.waitingRuns.length + inbox.memories.length + inbox.items.length === 0;

  async function reload(): Promise<void> {
    const result = await request<InboxView>('/inbox');
    if (result.ok) setInbox(result.data);
    router.refresh();
  }

  async function bulk(decision: 'confirm' | 'discard'): Promise<void> {
    setBusy(decision);
    setError(null);
    setOutcome(null);
    const result = await request<Bulk>(`/inbox/proposals/${decision}`, {
      method: 'POST',
      body: JSON.stringify({ ids: [...chosen], timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    });
    setBusy(null);
    if (!result.ok) {
      setError(messageFor(result.error, t));
      return;
    }
    const failed = result.data.results.filter((x) => x.error);
    setOutcome(k.results(result.data.results.length - failed.length, failed.length));
    if (failed[0]?.error) setError(failed[0].error);
    setChosen(new Set());
    await reload();
  }

  async function approve(id: string): Promise<void> {
    setBusy(id);
    const result = await request(`/memory/${id}/approve`, { method: 'POST' });
    setBusy(null);
    if (!result.ok) {
      setError(messageFor(result.error, t));
      return;
    }
    await reload();
  }

  async function resolve(id: string): Promise<void> {
    setBusy(id);
    const result = await request(`/inbox/items/${id}/resolve`, { method: 'POST' });
    setBusy(null);
    if (!result.ok) {
      setError(messageFor(result.error, t));
      return;
    }
    await reload();
  }

  async function readAll(): Promise<void> {
    setBusy('read');
    await request('/inbox/read', { method: 'POST', body: JSON.stringify({ ids: 'all' }) });
    setBusy(null);
    await reload();
  }

  const toggle = (id: string, on: boolean) =>
    setChosen((set) => {
      const next = new Set(set);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <>
      <PageHead eyebrow={k.eyebrow} title={k.titleTop} accent={k.titleAccent} lead={k.lead} />
      <div className="flex flex-col gap-6">
        {error && <Notice tone="danger">{error}</Notice>}
        {outcome && <Notice tone="pass">{outcome}</Notice>}
        {empty && (
          <Panel>
            <Empty title={k.empty} />
          </Panel>
        )}

        {inbox.proposals.length > 0 && (
          <Panel
            title={k.proposals}
            description={k.proposalsHint}
            actions={
              <Checkbox
                label={k.selectAll}
                checked={chosen.size === inbox.proposals.length}
                onChange={(on) => setChosen(on ? new Set(inbox.proposals.map((p) => p.id)) : new Set())}
              />
            }
          >
            <ul className="inbox-list">
              {inbox.proposals.map((p) => (
                <li key={p.id} className="inbox-row">
                  <Checkbox
                    label={
                      <>
                        <span className="cell-title">{p.title}</span>
                        <span className="cell-sub">
                          {p.conversationTitle} · {p.tool} · {k.expires} {date.format(new Date(p.expiresAt))}
                        </span>
                      </>
                    }
                    checked={chosen.has(p.id)}
                    onChange={(on) => toggle(p.id, on)}
                  />
                  <span className="inbox-row-tags">
                    <Tag tone={p.risk === 'danger' ? 'danger' : p.risk === 'caution' ? 'review' : 'neutral'}>{k.risks[p.risk]}</Tag>
                    {!p.reversible && <Tag tone="review">{k.irreversible}</Tag>}
                    <Link className="pill pill-ghost pill-sm" href={`/app/agent?c=${p.conversationId}`}>
                      {k.openConversation}
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12, flexWrap: 'wrap' }}>
              <Button variant="ghost" disabled={busy !== null || chosen.size === 0} onClick={() => void bulk('discard')}>
                {busy === 'discard' ? k.working : k.discard(chosen.size)}
              </Button>
              <Button variant="primary" disabled={busy !== null || chosen.size === 0} onClick={() => void bulk('confirm')}>
                {busy === 'confirm' ? k.working : k.confirm(chosen.size)}
              </Button>
            </div>
          </Panel>
        )}

        {inbox.waitingRuns.length > 0 && (
          <Panel title={k.waitingRuns}>
            <ul className="inbox-list">
              {inbox.waitingRuns.map((run) => (
                <li key={run.id} className="inbox-row">
                  <span>
                    <span className="cell-title">{run.goal.length > 120 ? `${run.goal.slice(0, 120)}…` : run.goal}</span>
                    <span className="cell-sub">{date.format(new Date(run.createdAt))}</span>
                  </span>
                  <span className="inbox-row-tags">
                    <Tag tone={runTone(run.status)}>{t.app.runs.statuses[run.status]}</Tag>
                    <Link className="pill pill-primary pill-sm" href={`/app/runs/${run.id}`}>
                      {k.open}
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {inbox.memories.length > 0 && (
          <Panel title={k.memories}>
            <ul className="inbox-list">
              {inbox.memories.map((m) => (
                <li key={m.id} className="inbox-row">
                  <span>
                    <span className="cell-title">{m.content}</span>
                    <span className="cell-sub">
                      {m.tier}
                      {m.teamId && ` · ${k.teamMemory}`} · {date.format(new Date(m.createdAt))}
                    </span>
                  </span>
                  <span className="inbox-row-tags">
                    <Link className="pill pill-ghost pill-sm" href="/app/memory">
                      {k.open}
                    </Link>
                    <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void approve(m.id)}>
                      {k.approve}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {inbox.items.length > 0 && (
          <Panel
            title={k.items}
            actions={
              inbox.items.some((i) => !i.readAt) ? (
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void readAll()}>
                  {k.markAllRead}
                </Button>
              ) : undefined
            }
          >
            <ul className="inbox-list">
              {inbox.items.map((item) => (
                <li key={item.id} className="inbox-row" data-unread={item.readAt ? undefined : ''}>
                  <span>
                    <span className="cell-title">{item.title}</span>
                    {item.body && <span className="cell-sub">{item.body}</span>}
                    <span className="cell-sub">{date.format(new Date(item.createdAt))}</span>
                  </span>
                  <span className="inbox-row-tags">
                    <Tag tone={item.kind === 'alert' ? 'danger' : item.kind === 'suggestion' ? 'brand' : 'neutral'}>{k.kinds[item.kind]}</Tag>
                    {item.suggestion && (
                      <Button size="sm" variant="brand" onClick={() => setMaking({ itemId: item.id, draft: item.suggestion! })}>
                        {k.makeIt}
                      </Button>
                    )}
                    {item.link && !item.suggestion && (
                      <Link className="pill pill-ghost pill-sm" href={item.link}>
                        {k.open}
                      </Link>
                    )}
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void resolve(item.id)}>
                      {k.resolve}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
      {making && (
        <AutomationForm
          locale={locale}
          agents={agents}
          teams={teams}
          automations={automations}
          draft={making.draft}
          onClose={() => setMaking(null)}
          onSaved={async (a) => {
            await request(`/inbox/items/${making.itemId}/resolve`, { method: 'POST' });
            setMaking(null);
            router.push(`/app/automations/${a.id}`);
          }}
        />
      )}
    </>
  );
}
