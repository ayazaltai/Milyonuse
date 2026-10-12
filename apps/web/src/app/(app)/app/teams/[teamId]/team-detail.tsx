'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Locale, RunStatus, RunSummaryView, RunView, StudioAgentView, TeamView } from '@milyonuse/contracts';
import { Button, Notice, PageHead, Panel, Tag } from '@/components/ui/primitives';
import { getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';
import { TeamBuilder } from '../team-builder';

export function runTone(status: RunStatus): 'pass' | 'review' | 'danger' | 'neutral' {
  return status === 'completed' ? 'pass' : status === 'waiting_approval' ? 'review' : status === 'failed' ? 'danger' : 'neutral';
}

export function TeamDetail({ locale, initial, runs, agents }: { locale: Locale; initial: TeamView; runs: RunSummaryView[]; agents: StudioAgentView[] }) {
  const t = getDictionary(locale);
  const k = t.app.teams;
  const r = t.app.runs;
  const router = useRouter();
  const [team, setTeam] = useState(initial);
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const number = new Intl.NumberFormat(locale);

  async function start(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await request<RunView>(`/teams/${team.id}/runs`, {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ goal: goal.trim(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    });
    if (!result.ok) {
      setBusy(false);
      setError(messageFor(result.error, t));
      return;
    }
    router.push(`/app/runs/${result.data.id}`);
  }

  return (
    <>
      <PageHead
        eyebrow={k.eyebrow}
        title={team.name}
        accent={k.modes[team.mode].label}
        lead={team.purpose || undefined}
        actions={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link className="pill pill-ghost" href="/app/teams">
              {k.back}
            </Link>
            <Button onClick={() => setEditing(true)}>{t.app.studio.edit}</Button>
          </div>
        }
      />
      <div className="studio-editor">
        <div className="studio-form">
          <Panel title={k.goal}>
            <form onSubmit={(e) => void start(e)} style={{ display: 'grid', gap: 10 }}>
              <textarea
                className="control control-area"
                placeholder={k.goalPlaceholder}
                value={goal}
                maxLength={4000}
                required
                onChange={(e) => setGoal(e.target.value)}
              />
              {error && <Notice tone="danger">{error}</Notice>}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button type="submit" variant="primary" disabled={busy || goal.trim().length < 3 || Boolean(team.archivedAt)}>
                  {busy ? k.starting : k.start}
                </Button>
              </div>
            </form>
          </Panel>
          <Panel title={k.recentRuns}>
            {runs.length === 0 ? (
              <p style={{ margin: 0, fontSize: 13.5, color: 'var(--w-50)' }}>{k.noRuns}</p>
            ) : (
              <div className="task-list">
                {runs.map((run) => (
                  <Link key={run.id} href={`/app/runs/${run.id}`} className="task-row" style={{ textDecoration: 'none', color: 'inherit' }}>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontSize: 13.5, color: 'var(--w-80)' }}>{run.goal}</p>
                      <p style={{ fontSize: 12, color: 'var(--w-50)', marginTop: 4 }}>
                        {new Date(run.createdAt).toLocaleString(locale)} · {r.spent(number.format(run.spentTokens), number.format(run.budgetTokens))}
                      </p>
                    </div>
                    <Tag tone={runTone(run.status)}>{r.statuses[run.status]}</Tag>
                  </Link>
                ))}
              </div>
            )}
          </Panel>
        </div>
        <aside className="studio-aside">
          <Panel title={k.members}>
            <div className="task-list">
              {team.members.map((m) => (
                <div key={m.agentId} className="studio-card-head">
                  <span className="studio-avatar" aria-hidden>
                    {m.avatar}
                  </span>
                  <div>
                    <p className="app-card-name" style={{ fontSize: 14 }}>
                      {m.name} <Tag>{k.roles[m.role]}</Tag>
                    </p>
                    <p className="app-card-text">{m.specialty || m.roleTitle}</p>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </aside>
      </div>
      {editing && (
        <TeamBuilder
          locale={locale}
          agents={agents}
          team={team}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setTeam(saved);
            setEditing(false);
          }}
        />
      )}
    </>
  );
}
