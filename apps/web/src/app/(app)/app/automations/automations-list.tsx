'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AutomationView, Locale, StudioAgentView, TeamView } from '@milyonuse/contracts';
import { Button, Empty, Notice, PageHead, Panel, Tag } from '@/components/ui/primitives';
import { getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';
import { AutomationForm, HookCard } from './automation-form';

export function when(locale: Locale, iso: string | null, never: string): string {
  if (!iso) return never;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export function outcomeTone(outcome: AutomationView['lastOutcome']): 'pass' | 'review' | 'danger' | 'neutral' {
  return outcome === 'completed' ? 'pass' : outcome === 'failed' ? 'danger' : outcome === 'waiting' ? 'review' : 'neutral';
}

export function AutomationsList({
  locale,
  initial,
  agents,
  teams,
}: {
  locale: Locale;
  initial: AutomationView[];
  agents: StudioAgentView[];
  teams: TeamView[];
}) {
  const t = getDictionary(locale);
  const k = t.app.automations;
  const router = useRouter();
  const [automations, setAutomations] = useState(initial);
  const [making, setMaking] = useState(false);
  const [made, setMade] = useState<AutomationView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(a: AutomationView): Promise<void> {
    setBusy(a.id);
    setError(null);
    const result = await request<AutomationView>(`/automations/${a.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !a.enabled }) });
    setBusy(null);
    if (!result.ok) {
      setError(messageFor(result.error, t));
      return;
    }
    setAutomations((list) => list.map((x) => (x.id === a.id ? result.data : x)));
  }

  return (
    <>
      <PageHead
        eyebrow={k.eyebrow}
        title={k.titleTop}
        accent={k.titleAccent}
        lead={k.lead}
        actions={
          <Button variant="primary" onClick={() => setMaking(true)}>
            {k.create}
          </Button>
        }
      />
      <div className="flex flex-col gap-6">
        {error && <Notice tone="danger">{error}</Notice>}
        {made?.hook?.secret && (
          <Panel title={`${made.name} — ${k.hookTitle}`}>
            <HookCard locale={locale} hook={made.hook} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              <Button size="sm" onClick={() => router.push(`/app/automations/${made.id}`)}>
                {k.done}
              </Button>
            </div>
          </Panel>
        )}
        {automations.length === 0 ? (
          <Panel>
            <Empty title={k.none} />
          </Panel>
        ) : (
          <div className="app-cards">
            {automations.map((a) => (
              <article key={a.id} className="app-card" data-connected={a.enabled ? '' : undefined}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <p className="app-card-name">{a.name}</p>
                    <p className="app-card-text">{a.targetName}</p>
                  </div>
                  <button
                    type="button"
                    className="switch"
                    role="switch"
                    aria-checked={a.enabled}
                    aria-label={`${a.name}: ${a.enabled ? k.on : k.off}`}
                    disabled={busy === a.id}
                    onClick={() => void toggle(a)}
                  >
                    <span className="switch-knob" />
                  </button>
                </div>
                <div className="studio-meta">
                  <Tag tone="brand">{k.kinds[a.kind].label}</Tag>
                  {a.pausedReason && !a.enabled && <Tag tone="review">{k.paused}</Tag>}
                  {a.lastOutcome && <Tag tone={outcomeTone(a.lastOutcome)}>{k.outcomes[a.lastOutcome]}</Tag>}
                </div>
                <dl className="automation-facts">
                  {a.nextRunAt && (
                    <>
                      <dt>{k.nextRun}</dt>
                      <dd>{when(locale, a.nextRunAt, k.never)}</dd>
                    </>
                  )}
                  <dt>{k.lastRun}</dt>
                  <dd>{when(locale, a.lastRunAt, k.never)}</dd>
                </dl>
                {a.pausedReason && !a.enabled && <p className="app-card-text">{a.pausedReason}</p>}
                <div className="app-card-actions">
                  <Link className="pill pill-primary pill-sm" href={`/app/automations/${a.id}`}>
                    {k.open}
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
      {making && (
        <AutomationForm
          locale={locale}
          agents={agents}
          teams={teams}
          automations={automations}
          onClose={() => setMaking(false)}
          onSaved={(a) => {
            setMaking(false);
            if (a.hook?.secret) {
              setAutomations((list) => [...list, a]);
              setMade(a);
              return;
            }
            router.push(`/app/automations/${a.id}`);
          }}
        />
      )}
    </>
  );
}
