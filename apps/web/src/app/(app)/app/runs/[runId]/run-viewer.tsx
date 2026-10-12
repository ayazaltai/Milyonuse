'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Locale, RunView } from '@milyonuse/contracts';
import { Button, Field, Notice, PageHead, Panel, Tag } from '@/components/ui/primitives';
import { getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';
import { MessageText } from '../../agent/message-text';
import { runTone } from '../../teams/[teamId]/team-detail';
import { RunGraph } from './run-graph';

const LIVE = new Set(['queued', 'running']);

/**
 * A run as it moves: while the queue works on it the page looks again every
 * few seconds; the person can stop it, add to its budget when it waits for
 * them, or run a failed or interrupted task again.
 */
export function RunViewer({ locale, initial }: { locale: Locale; initial: RunView }) {
  const t = getDictionary(locale);
  const r = t.app.runs;
  const [run, setRun] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [add, setAdd] = useState(100_000);
  const number = new Intl.NumberFormat(locale);
  const live = LIVE.has(run.status);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      void request<RunView>(`/runs/${run.id}`).then((res) => {
        if (res.ok) setRun(res.data);
      });
    }, 2500);
    return () => clearInterval(timer);
  }, [live, run.id]);

  async function act(key: string, path: string, body: unknown = {}): Promise<void> {
    setBusy(key);
    setError(null);
    const result = await request<RunView>(`/runs/${run.id}${path}`, { method: 'POST', body: JSON.stringify(body) });
    setBusy(null);
    if (!result.ok) {
      setError(messageFor(result.error, t));
      return;
    }
    setRun(result.data);
  }

  const who = new Map(run.members.map((m) => [m.agentId, m]));

  return (
    <>
      <PageHead
        eyebrow={r.eyebrow}
        title={run.goal.length > 80 ? `${run.goal.slice(0, 79)}…` : run.goal}
        accent={r.statuses[run.status]}
        actions={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {run.teamId && (
              <Link className="pill pill-ghost" href={`/app/teams/${run.teamId}`}>
                {r.back}
              </Link>
            )}
            <Link className="pill pill-ghost" href={`/app/agent?c=${run.conversationId}`}>
              {r.openConversation}
            </Link>
            {run.status !== 'completed' && run.status !== 'cancelled' && (
              <Button variant="danger" disabled={busy !== null} onClick={() => void act('stop', '/cancel')}>
                {busy === 'stop' ? r.stopping : r.stop}
              </Button>
            )}
          </div>
        }
      />
      <div className="studio-editor">
        <div className="studio-form">
          <div className="studio-meta">
            <Tag tone={runTone(run.status)}>{r.statuses[run.status]}</Tag>
            <Tag>{r.spent(number.format(run.spentTokens), number.format(run.budgetTokens))}</Tag>
            {run.mode && <Tag>{t.app.teams.modes[run.mode].label}</Tag>}
          </div>
          {error && <Notice tone="danger">{error}</Notice>}
          {run.error && run.status !== 'completed' && <Notice tone={run.status === 'waiting_approval' ? 'review' : 'danger'}>{run.error}</Notice>}
          {run.proposals > 0 && (
            <Notice tone="review">
              {r.proposals(run.proposals)} —{' '}
              <Link href={`/app/agent?c=${run.conversationId}`} style={{ color: 'inherit' }}>
                {r.openConversation}
              </Link>
            </Notice>
          )}
          {run.status === 'waiting_approval' && (
            <Panel>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 200px' }}>
                  <Field label={r.addTokens}>
                    <input className="control" type="number" min={1000} step={10000} value={add} onChange={(e) => setAdd(Number(e.target.value))} />
                  </Field>
                </div>
                <Button variant="primary" disabled={busy !== null || add < 1000} onClick={() => void act('resume', '/resume', { addTokens: add })}>
                  {busy === 'resume' ? r.resuming : r.resume}
                </Button>
              </div>
            </Panel>
          )}

          <Panel title={r.graph}>
            {run.tasks.length === 0 ? (
              <p style={{ margin: 0, fontSize: 13.5, color: 'var(--w-50)' }}>{live ? r.planning : '—'}</p>
            ) : (
              <RunGraph tasks={run.tasks} members={run.members} labels={r.taskStatuses} />
            )}
          </Panel>

          {run.tasks.length > 0 && (
            <div className="task-list">
              {run.tasks.map((task) => {
                const member = task.assignedAgentId ? who.get(task.assignedAgentId) : undefined;
                return (
                  <div key={task.id} className="task-row">
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontSize: 13.5, color: 'var(--w-80)' }}>
                        <span style={{ color: 'var(--w-50)' }}>{task.key}</span> {task.title}
                      </p>
                      <p style={{ fontSize: 12, color: 'var(--w-50)', marginTop: 2 }}>
                        {member ? `${member.avatar} ${member.name}` : ''} {task.attempts > 0 ? `· ${r.attempts(task.attempts)}` : ''}
                      </p>
                      {task.error && <p style={{ fontSize: 12.5, color: 'var(--danger)', marginTop: 4 }}>{task.error}</p>}
                      <details>
                        <summary>{r.contract}</summary>
                        <p style={{ fontSize: 12.5, color: 'var(--w-60)', marginTop: 6, whiteSpace: 'pre-wrap' }}>
                          {[task.goal, task.context, task.successCriteria].filter(Boolean).join('\n\n')}
                        </p>
                      </details>
                      {task.output && (
                        <details>
                          <summary>{r.output}</summary>
                          <div className="run-result" style={{ marginTop: 6 }}>
                            <MessageText text={task.output} />
                          </div>
                        </details>
                      )}
                    </div>
                    <div style={{ display: 'grid', gap: 6, justifyItems: 'end' }}>
                      <Tag tone={task.status === 'done' ? 'pass' : task.status === 'failed' || task.status === 'uncertain' ? 'danger' : 'neutral'}>{r.taskStatuses[task.status]}</Tag>
                      {['failed', 'uncertain', 'cancelled'].includes(task.status) && run.status !== 'completed' && run.status !== 'cancelled' && (
                        <Button size="sm" disabled={busy !== null} onClick={() => void act(task.id, `/tasks/${task.id}/rerun`)}>
                          {r.rerun}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <Panel title={r.result}>
            {run.result ? (
              <div className="run-result">
                <MessageText text={run.result} />
              </div>
            ) : (
              <p style={{ margin: 0, fontSize: 13.5, color: 'var(--w-50)' }}>{r.noResult}</p>
            )}
          </Panel>
        </div>
        <aside className="studio-aside">
          <Panel title={r.steps}>
            <ol className="run-steps">
              {run.steps.map((s) => (
                <li key={s.seq}>
                  <span className="seq">{s.seq}</span>
                  <span className="kind">{r.kinds[s.kind]}</span>
                  <span>{s.summary}</span>
                </li>
              ))}
            </ol>
          </Panel>
        </aside>
      </div>
    </>
  );
}
