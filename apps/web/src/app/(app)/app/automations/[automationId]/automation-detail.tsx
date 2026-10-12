'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AutomationDetailView, AutomationTriggerView, AutomationView, Locale, StudioAgentView, TeamView } from '@milyonuse/contracts';
import { Button, Empty, Field, Notice, PageHead, Panel, Table, Tag, Td, Th } from '@/components/ui/primitives';
import { getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';
import { runTone } from '../../teams/[teamId]/team-detail';
import { AutomationForm, HookCard } from '../automation-form';
import { outcomeTone, when } from '../automations-list';

function triggerTone(status: AutomationTriggerView['status']): 'pass' | 'review' | 'danger' | 'neutral' {
  return status === 'started' ? 'pass' : status === 'failed' ? 'danger' : status === 'accepted' ? 'review' : 'neutral';
}

export function AutomationDetail({
  locale,
  initial,
  automations,
  agents,
  teams,
}: {
  locale: Locale;
  initial: AutomationDetailView;
  automations: AutomationView[];
  agents: StudioAgentView[];
  teams: TeamView[];
}) {
  const t = getDictionary(locale);
  const k = t.app.automations;
  const r = t.app.runs;
  const router = useRouter();
  const [a, setA] = useState(initial);
  const [hook, setHook] = useState(initial.hook);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<AutomationTriggerView | null>(null);
  const number = new Intl.NumberFormat(locale);

  async function reload(): Promise<void> {
    const result = await request<AutomationDetailView>(`/automations/${a.id}`);
    if (result.ok) setA(result.data);
  }

  async function patch(body: Record<string, unknown>): Promise<void> {
    setBusy('patch');
    setError(null);
    const result = await request<AutomationView>(`/automations/${a.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    setBusy(null);
    if (!result.ok) {
      setError(messageFor(result.error, t));
      return;
    }
    await reload();
  }

  async function fire(verb: 'run' | 'test'): Promise<void> {
    setBusy(verb);
    setError(null);
    setStarted(null);
    const result = await request<{ trigger: AutomationTriggerView }>(`/automations/${a.id}/${verb}`, {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify(input.trim() ? { input: input.trim() } : {}),
    });
    setBusy(null);
    if (!result.ok) {
      setError(messageFor(result.error, t));
      return;
    }
    setStarted(result.data.trigger);
    await reload();
  }

  async function rotate(): Promise<void> {
    if (!window.confirm(k.rotateConfirm)) return;
    setBusy('rotate');
    const result = await request<AutomationView>(`/automations/${a.id}/rotate-hook`, { method: 'POST' });
    setBusy(null);
    if (!result.ok) {
      setError(messageFor(result.error, t));
      return;
    }
    setHook(result.data.hook);
  }

  async function remove(): Promise<void> {
    if (!window.confirm(k.removeConfirm)) return;
    setBusy('remove');
    const result = await request(`/automations/${a.id}`, { method: 'DELETE' });
    if (!result.ok) {
      setBusy(null);
      setError(messageFor(result.error, t));
      return;
    }
    router.push('/app/automations');
  }

  return (
    <>
      <PageHead
        eyebrow={k.kinds[a.kind].label}
        title={a.name}
        accent={a.targetName}
        lead={a.prompt.length > 220 ? `${a.prompt.slice(0, 220)}…` : a.prompt}
        actions={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link className="pill pill-ghost" href="/app/automations">
              {k.back}
            </Link>
            <Button onClick={() => setEditing(true)}>{k.edit}</Button>
          </div>
        }
      />
      <div className="studio-editor">
        <div className="studio-form">
          {error && <Notice tone="danger">{error}</Notice>}
          <Panel
            title={a.enabled ? k.on : k.off}
            actions={
              <button
                type="button"
                className="switch"
                role="switch"
                aria-checked={a.enabled}
                aria-label={`${a.name}: ${a.enabled ? k.on : k.off}`}
                disabled={busy !== null}
                onClick={() => void patch({ enabled: !a.enabled })}
              >
                <span className="switch-knob" />
              </button>
            }
          >
            <dl className="automation-facts">
              {a.enabled && a.nextRunAt && (
                <>
                  <dt>{k.nextRun}</dt>
                  <dd>{when(locale, a.nextRunAt, k.never)}</dd>
                </>
              )}
              <dt>{k.lastRun}</dt>
              <dd>
                {when(locale, a.lastRunAt, k.never)} {a.lastOutcome && <Tag tone={outcomeTone(a.lastOutcome)}>{k.outcomes[a.lastOutcome]}</Tag>}
              </dd>
              <dt>{k.safety}</dt>
              <dd>{k.policies[a.policy].label}</dd>
              <dt>{k.failure}</dt>
              <dd>
                {k.failures[a.failurePolicy]}
                {a.consecutiveFailures > 0 && ` · ${k.failuresInRow(a.consecutiveFailures)}`}
              </dd>
            </dl>
            {a.pausedReason && !a.enabled && (
              <div style={{ marginTop: 12 }}>
                <Notice tone="review">{a.pausedReason}</Notice>
              </div>
            )}
          </Panel>

          <Panel title={k.runNow} description={k.testHint}>
            <div style={{ display: 'grid', gap: 10 }}>
              <Field label={k.testInput}>
                <textarea className="control control-area" rows={2} value={input} maxLength={20000} onChange={(e) => setInput(e.target.value)} />
              </Field>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Button variant="primary" disabled={busy !== null || !a.enabled} onClick={() => void fire('run')}>
                  {busy === 'run' ? k.running : k.runNow}
                </Button>
                <Button disabled={busy !== null} onClick={() => void fire('test')}>
                  {busy === 'test' ? k.running : k.test}
                </Button>
                {started && (
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                    <Tag tone={triggerTone(started.status)}>{k.triggerStatuses[started.status]}</Tag>
                    {started.reason && <span style={{ color: 'var(--w-60)' }}>{started.reason}</span>}
                    {started.runId && (
                      <Link className="pill pill-ghost pill-sm" href={`/app/runs/${started.runId}`}>
                        {k.openRun}
                      </Link>
                    )}
                  </span>
                )}
              </div>
            </div>
          </Panel>

          {hook && (
            <Panel
              title={k.hookTitle}
              actions={
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void rotate()}>
                  {k.rotate}
                </Button>
              }
            >
              <HookCard locale={locale} hook={hook} />
            </Panel>
          )}

          {a.monitor && (
            <Panel title={k.monitor} description={a.monitorUrl ?? undefined}>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--w-60)' }}>
                {k.checks(a.monitor.checks, a.monitor.changes)} · {k.lastChecked}: {when(locale, a.monitor.lastCheckedAt, k.never)}
              </p>
              {a.monitor.excerpt && <p className="automation-excerpt">{a.monitor.excerpt}</p>}
            </Panel>
          )}
        </div>

        <div className="studio-form">
          <Panel title={k.runs} flush>
            {a.runs.length === 0 ? (
              <Empty title={k.noRuns} />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>{t.app.runList.started}</Th>
                    <Th>{t.app.runList.status}</Th>
                    <Th num>{t.app.runList.spent}</Th>
                  </tr>
                </thead>
                <tbody>
                  {a.runs.map((run) => (
                    <tr key={run.id}>
                      <Td nowrap>
                        <Link href={`/app/runs/${run.id}`}>{when(locale, run.createdAt, k.never)}</Link>
                      </Td>
                      <Td>
                        <Tag tone={runTone(run.status)}>{r.statuses[run.status]}</Tag>
                      </Td>
                      <Td num>{number.format(run.spentTokens)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>

          <Panel title={k.triggers} flush>
            {a.triggers.length === 0 ? (
              <Empty title={k.noTriggers} />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>{t.app.runList.started}</Th>
                    <Th>{k.kind}</Th>
                    <Th>{t.app.runList.status}</Th>
                  </tr>
                </thead>
                <tbody>
                  {a.triggers.map((trigger) => (
                    <tr key={trigger.id}>
                      <Td nowrap>{when(locale, trigger.createdAt, k.never)}</Td>
                      <Td>{k.sources[trigger.source]}</Td>
                      <Td>
                        <Tag tone={triggerTone(trigger.status)}>{k.triggerStatuses[trigger.status]}</Tag>
                        {trigger.reason && <span className="cell-sub"> {trigger.reason}</span>}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => void remove()}>
              {k.remove}
            </Button>
          </div>
        </div>
      </div>
      {editing && (
        <AutomationForm
          locale={locale}
          agents={agents}
          teams={teams}
          automations={automations}
          automation={a}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void reload();
          }}
        />
      )}
    </>
  );
}
