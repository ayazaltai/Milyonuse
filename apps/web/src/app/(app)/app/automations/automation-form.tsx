'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AUTOMATION_KINDS,
  type AutomationDraftView,
  type AutomationKind,
  type AutomationView,
  CADENCES,
  type Cadence,
  type Locale,
  type StudioAgentView,
  type TeamView,
} from '@milyonuse/contracts';
import { Button, Checkbox, Field, Notice, Tag } from '@/components/ui/primitives';
import { getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';

const TIMED: AutomationKind[] = ['schedule', 'monitor', 'goal'];
type Policy = 'safe_only' | 'trusted';
type Failure = 'pause' | 'notify' | 'retry';
type Event = 'run.completed' | 'run.failed';

interface State {
  name: string;
  kind: AutomationKind;
  target: string;
  prompt: string;
  cadence: Cadence;
  weekdays: number[];
  monthDay: number;
  localTime: string;
  everyHours: number;
  timeZone: string;
  monitorUrl: string;
  monitorCondition: string;
  goalUntil: string;
  watchAutomationId: string;
  watchTeamId: string;
  watchEvents: Event[];
  policy: Policy;
  confirmTrusted: boolean;
  quiet: boolean;
  quietStart: string;
  quietEnd: string;
  budgetTokens: number;
  dailyCap: number;
  failurePolicy: Failure;
  notify: ('inbox' | 'email')[];
}

const browserZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

function monthEnd(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

function fromView(a: AutomationView): State {
  return {
    name: a.name,
    kind: a.kind,
    target: a.target.agentId ? `agent:${a.target.agentId}` : `team:${a.target.teamId}`,
    prompt: a.prompt,
    cadence: a.cadence ?? 'daily',
    weekdays: a.weekdays,
    monthDay: a.monthDay ?? 1,
    localTime: a.localTime ?? '09:00',
    everyHours: a.everyHours ?? 1,
    timeZone: a.timeZone,
    monitorUrl: a.monitorUrl ?? '',
    monitorCondition: a.monitorCondition ?? '',
    goalUntil: a.goalUntil ?? monthEnd(),
    watchAutomationId: a.watchAutomationId ?? '',
    watchTeamId: a.watchTeamId ?? '',
    watchEvents: a.watchEvents,
    policy: a.policy,
    confirmTrusted: a.policy === 'trusted',
    quiet: a.quietHours !== null,
    quietStart: a.quietHours?.start ?? '22:00',
    quietEnd: a.quietHours?.end ?? '07:00',
    budgetTokens: a.budgetTokens,
    dailyCap: a.dailyCap,
    failurePolicy: a.failurePolicy,
    notify: a.notify,
  };
}

function blank(target: string): State {
  return {
    name: '',
    kind: 'schedule',
    target,
    prompt: '',
    cadence: 'daily',
    weekdays: [1],
    monthDay: 1,
    localTime: '09:00',
    everyHours: 1,
    timeZone: browserZone(),
    monitorUrl: '',
    monitorCondition: '',
    goalUntil: monthEnd(),
    watchAutomationId: '',
    watchTeamId: '',
    watchEvents: ['run.completed'],
    policy: 'safe_only',
    confirmTrusted: false,
    quiet: false,
    quietStart: '22:00',
    quietEnd: '07:00',
    budgetTokens: 200_000,
    dailyCap: 24,
    failurePolicy: 'pause',
    notify: ['inbox'],
  };
}

function withDraft(s: State, d: AutomationDraftView): State {
  return {
    ...s,
    name: d.name.slice(0, 80),
    kind: d.kind,
    prompt: d.prompt.slice(0, 4000),
    cadence: d.cadence ?? s.cadence,
    weekdays: d.weekdays.length ? d.weekdays : s.weekdays,
    monthDay: d.monthDay ?? s.monthDay,
    localTime: d.localTime ?? s.localTime,
    everyHours: d.everyHours ?? s.everyHours,
    monitorUrl: d.monitorUrl ?? '',
    monitorCondition: d.monitorCondition ?? '',
    goalUntil: d.goalUntil ?? s.goalUntil,
  };
}

/**
 * Making or changing an automation (F6 §4). A new one starts from the
 * person's own words — read on the server into a configuration they look
 * over — or by hand. Trusting it with reversible work takes a sentence they
 * tick themselves; the server refuses it otherwise.
 */
export function AutomationForm({
  locale,
  agents,
  teams,
  automations,
  automation,
  draft,
  onClose,
  onSaved,
}: {
  locale: Locale;
  agents: StudioAgentView[];
  teams: TeamView[];
  automations: AutomationView[];
  automation?: AutomationView;
  /** A suggestion's configuration, to start from. */
  draft?: AutomationDraftView;
  onClose: () => void;
  onSaved: (automation: AutomationView) => void;
}) {
  const t = getDictionary(locale);
  const k = t.app.automations;
  const dialog = useRef<HTMLDialogElement>(null);
  const liveAgents = agents.filter((a) => !a.archivedAt);
  const liveTeams = teams.filter((x) => !x.archivedAt);
  const firstTarget = liveAgents[0] ? `agent:${liveAgents[0].id}` : liveTeams[0] ? `team:${liveTeams[0].id}` : '';
  const [s, setS] = useState<State>(() => {
    if (automation) return fromView(automation);
    return draft ? withDraft(blank(firstTarget), draft) : blank(firstTarget);
  });
  const [words, setWords] = useState('');
  const [understood, setUnderstood] = useState<string[]>(draft?.understood ?? []);
  const [busy, setBusy] = useState<'draft' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const set = (patch: Partial<State>) => setS((v) => ({ ...v, ...patch }));
  const timed = TIMED.includes(s.kind);
  const needsTrust = s.policy === 'trusted' && automation?.policy !== 'trusted';
  const valid =
    s.name.trim() !== '' &&
    s.prompt.trim() !== '' &&
    s.target !== '' &&
    (!timed || s.cadence !== 'weekly' || s.weekdays.length > 0) &&
    (s.kind !== 'monitor' || /^https:\/\/\S+$/.test(s.monitorUrl)) &&
    (s.kind !== 'agent_event' || s.watchAutomationId !== '' || s.watchTeamId !== '') &&
    (!needsTrust || s.confirmTrusted);

  async function read(): Promise<void> {
    setBusy('draft');
    setError(null);
    const result = await request<AutomationDraftView>('/automations/draft', { method: 'POST', body: JSON.stringify({ text: words.trim() }) });
    setBusy(null);
    if (!result.ok) {
      setError(messageFor(result.error, t));
      return;
    }
    setS((v) => withDraft(v, result.data));
    setUnderstood(result.data.understood);
  }

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy('save');
    setError(null);
    const [targetKind, targetId] = s.target.split(':') as ['agent' | 'team', string];
    const body: Record<string, unknown> = {
      name: s.name.trim(),
      target: targetKind === 'agent' ? { agentId: targetId } : { teamId: targetId },
      prompt: s.prompt.trim(),
      policy: s.policy,
      ...(needsTrust ? { confirmTrusted: true } : {}),
      timeZone: s.timeZone.trim() || 'UTC',
      quietHours: s.quiet ? { start: s.quietStart, end: s.quietEnd } : null,
      budgetTokens: s.budgetTokens,
      dailyCap: s.dailyCap,
      failurePolicy: s.failurePolicy,
      notify: s.notify,
      cadence: timed ? s.cadence : null,
      weekdays: timed && s.cadence === 'weekly' ? s.weekdays : [],
      monthDay: timed && s.cadence === 'monthly' ? s.monthDay : null,
      localTime: timed ? (s.cadence === 'hourly' ? `00:${s.localTime.slice(3)}` : s.localTime) : null,
      everyHours: timed && s.cadence === 'hourly' ? s.everyHours : null,
      monitorUrl: s.kind === 'monitor' ? s.monitorUrl.trim() : null,
      monitorCondition: s.kind === 'monitor' ? s.monitorCondition.trim() || null : null,
      goalUntil: s.kind === 'goal' ? s.goalUntil : null,
      watchAutomationId: s.kind === 'agent_event' ? s.watchAutomationId || null : null,
      watchTeamId: s.kind === 'agent_event' ? s.watchTeamId || null : null,
      watchEvents: s.watchEvents.length ? s.watchEvents : ['run.completed'],
    };
    const result = automation
      ? await request<AutomationView>(`/automations/${automation.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      : await request<AutomationView>('/automations', {
          method: 'POST',
          headers: { 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify({ ...body, kind: s.kind }),
        });
    setBusy(null);
    if (!result.ok) {
      setError(messageFor(result.error, t));
      return;
    }
    onSaved(result.data);
  }

  const toggleDay = (day: number) =>
    set({ weekdays: s.weekdays.includes(day) ? s.weekdays.filter((d) => d !== day) : [...s.weekdays, day].sort() });

  return (
    <dialog ref={dialog} className="dialog dialog-wide" onClose={onClose} aria-labelledby="automation-title">
      <div className="dialog-head">
        <div>
          <p className="eyebrow">{k.eyebrow}</p>
          <h2 id="automation-title" className="dialog-title">
            {automation ? automation.name : k.wizardTitle}
          </h2>
        </div>
        <Button size="sm" variant="ghost" onClick={() => dialog.current?.close()}>
          {k.cancel}
        </Button>
      </div>
      {firstTarget === '' && !automation ? (
        <Notice tone="review">{k.noTargets}</Notice>
      ) : (
        <form onSubmit={(e) => void save(e)} className="studio-form">
          {!automation && (
            <div className="automation-describe">
              <Field label={k.describeTitle} hint={k.describeHint}>
                <textarea className="control control-area" rows={2} value={words} maxLength={2000} onChange={(e) => setWords(e.target.value)} />
              </Field>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button type="button" variant="brand" size="sm" disabled={busy !== null || words.trim().length < 3} onClick={() => void read()}>
                  {busy === 'draft' ? k.describing : k.describe}
                </Button>
                {understood.length > 0 && (
                  <span className="automation-understood">
                    {k.understood}:{' '}
                    {understood.map((u) => (
                      <Tag key={u} tone="brand">
                        {u}
                      </Tag>
                    ))}
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="studio-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
            <Field label={k.name}>
              <input className="control" value={s.name} maxLength={80} required onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label={k.target}>
              <select className="control" value={s.target} onChange={(e) => set({ target: e.target.value })}>
                {liveAgents.length > 0 && (
                  <optgroup label={k.targetAgents}>
                    {liveAgents.map((a) => (
                      <option key={a.id} value={`agent:${a.id}`}>
                        {a.avatar} {a.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {liveTeams.length > 0 && (
                  <optgroup label={k.targetTeams}>
                    {liveTeams.map((x) => (
                      <option key={x.id} value={`team:${x.id}`}>
                        {x.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </Field>
          </div>

          {!automation && (
            <div className="field" role="group" aria-label={k.kind}>
              <span className="field-label">{k.kind}</span>
              <div className="choices">
                {AUTOMATION_KINDS.map((kind) => (
                  <button key={kind} type="button" className="choice" aria-pressed={kind === s.kind} onClick={() => set({ kind })}>
                    <span className="choice-label">{k.kinds[kind].label}</span>
                    <span className="choice-hint">{k.kinds[kind].hint}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <Field label={k.prompt} hint={k.promptHint}>
            <textarea className="control control-area" value={s.prompt} maxLength={4000} required onChange={(e) => set({ prompt: e.target.value })} />
          </Field>

          {timed && (
            <div className="automation-when">
              <Field label={k.cadence}>
                <select className="control" value={s.cadence} onChange={(e) => set({ cadence: e.target.value as Cadence })}>
                  {CADENCES.map((c) => (
                    <option key={c} value={c}>
                      {k.cadences[c]}
                    </option>
                  ))}
                </select>
              </Field>
              {s.cadence === 'hourly' ? (
                <Field label={k.everyHours}>
                  <input className="control" type="number" min={1} max={24} value={s.everyHours} onChange={(e) => set({ everyHours: Number(e.target.value) })} />
                </Field>
              ) : (
                <Field label={k.localTime}>
                  <input className="control" type="time" value={s.localTime} required onChange={(e) => set({ localTime: e.target.value })} />
                </Field>
              )}
              {s.cadence === 'monthly' && (
                <Field label={k.monthDay}>
                  <input className="control" type="number" min={1} max={31} value={s.monthDay} onChange={(e) => set({ monthDay: Number(e.target.value) })} />
                </Field>
              )}
              <Field label={k.timeZone}>
                <input className="control" value={s.timeZone} maxLength={64} onChange={(e) => set({ timeZone: e.target.value })} />
              </Field>
              {s.cadence === 'weekly' && (
                <div className="field" role="group" aria-label={k.weekdays} style={{ gridColumn: '1 / -1' }}>
                  <span className="field-label">{k.weekdays}</span>
                  <div className="day-picks">
                    {k.days.map((label, i) => (
                      <button key={label} type="button" className="day-pick" aria-pressed={s.weekdays.includes(i + 1)} onClick={() => toggleDay(i + 1)}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {s.kind === 'monitor' && (
            <div className="studio-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
              <Field label={k.monitorUrl}>
                <input className="control" type="url" placeholder="https://" value={s.monitorUrl} maxLength={2000} required onChange={(e) => set({ monitorUrl: e.target.value })} />
              </Field>
              <Field label={k.monitorCondition}>
                <input className="control" value={s.monitorCondition} maxLength={500} onChange={(e) => set({ monitorCondition: e.target.value })} />
              </Field>
            </div>
          )}

          {s.kind === 'goal' && (
            <Field label={k.goalUntil}>
              <input className="control" type="date" value={s.goalUntil} required onChange={(e) => set({ goalUntil: e.target.value })} />
            </Field>
          )}

          {s.kind === 'agent_event' && (
            <div className="studio-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
              <Field label={k.watchAutomation}>
                <select className="control" value={s.watchAutomationId} onChange={(e) => set({ watchAutomationId: e.target.value, watchTeamId: e.target.value ? '' : s.watchTeamId })}>
                  <option value="">{k.watchNone}</option>
                  {automations
                    .filter((a) => a.id !== automation?.id)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label={k.watchTeam}>
                <select className="control" value={s.watchTeamId} onChange={(e) => set({ watchTeamId: e.target.value, watchAutomationId: e.target.value ? '' : s.watchAutomationId })}>
                  <option value="">{k.watchNone}</option>
                  {liveTeams.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="field" role="group" aria-label={k.watchEvents} style={{ gridColumn: '1 / -1' }}>
                <span className="field-label">{k.watchEvents}</span>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {(['run.completed', 'run.failed'] as const).map((ev) => (
                    <Checkbox
                      key={ev}
                      label={k.events[ev === 'run.completed' ? 'completed' : 'failed']}
                      checked={s.watchEvents.includes(ev)}
                      onChange={(on) => set({ watchEvents: on ? [...s.watchEvents, ev] : s.watchEvents.filter((x) => x !== ev) })}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="field" role="group" aria-label={k.safety}>
            <span className="field-label">{k.safety}</span>
            <div className="choices">
              {(['safe_only', 'trusted'] as const).map((p) => (
                <button key={p} type="button" className="choice" aria-pressed={p === s.policy} onClick={() => set({ policy: p })}>
                  <span className="choice-label">{k.policies[p].label}</span>
                  <span className="choice-hint">{k.policies[p].hint}</span>
                </button>
              ))}
            </div>
            {needsTrust && (
              <div style={{ marginTop: 8 }}>
                <Notice tone="review">
                  <Checkbox label={k.confirmTrusted} checked={s.confirmTrusted} onChange={(on) => set({ confirmTrusted: on })} />
                </Notice>
              </div>
            )}
          </div>

          <details className="automation-advanced">
            <summary>{k.advanced}</summary>
            <div className="automation-when" style={{ marginTop: 12 }}>
              <Field label={k.budget}>
                <input className="control" type="number" min={10000} max={5000000} step={10000} value={s.budgetTokens} onChange={(e) => set({ budgetTokens: Number(e.target.value) })} />
              </Field>
              <Field label={k.dailyCap}>
                <input className="control" type="number" min={1} max={500} value={s.dailyCap} onChange={(e) => set({ dailyCap: Number(e.target.value) })} />
              </Field>
              <Field label={k.failure}>
                <select className="control" value={s.failurePolicy} onChange={(e) => set({ failurePolicy: e.target.value as Failure })}>
                  {(['pause', 'notify', 'retry'] as const).map((f) => (
                    <option key={f} value={f}>
                      {k.failures[f]}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="field" role="group" aria-label={k.notify}>
                <span className="field-label">{k.notify}</span>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {(['inbox', 'email'] as const).map((c) => (
                    <Checkbox
                      key={c}
                      label={k.channels[c]}
                      checked={s.notify.includes(c)}
                      onChange={(on) => set({ notify: on ? [...s.notify, c] : s.notify.filter((x) => x !== c) })}
                    />
                  ))}
                </div>
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <Checkbox label={k.quietHours} hint={k.quietHint} checked={s.quiet} onChange={(on) => set({ quiet: on })} />
                {s.quiet && (
                  <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
                    <Field label={k.quietFrom}>
                      <input className="control" type="time" value={s.quietStart} onChange={(e) => set({ quietStart: e.target.value })} />
                    </Field>
                    <Field label={k.quietTo}>
                      <input className="control" type="time" value={s.quietEnd} onChange={(e) => set({ quietEnd: e.target.value })} />
                    </Field>
                  </div>
                )}
              </div>
            </div>
          </details>

          {error && <Notice tone="danger">{error}</Notice>}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button type="submit" variant="primary" disabled={busy !== null || !valid}>
              {busy === 'save' ? k.saving : k.save}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}

/** A webhook's or mail automation's address, and its secret the one time it is shown. */
export function HookCard({ locale, hook }: { locale: Locale; hook: NonNullable<AutomationView['hook']> }) {
  const k = getDictionary(locale).app.automations;
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value).then(() => setCopied(value));
  };
  const row = (label: string, value: string) => (
    <div className="hook-row">
      <span className="field-label">{label}</span>
      <code className="control-code hook-value">{value}</code>
      <Button size="sm" variant="ghost" type="button" onClick={() => copy(value)}>
        {copied === value ? k.copied : k.copy}
      </Button>
    </div>
  );
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {row(k.hookUrl, hook.url)}
      {row(k.hookEmail, hook.email)}
      {hook.secret && (
        <>
          {row(k.secret, hook.secret)}
          <Notice tone="review">{k.secretOnce}</Notice>
        </>
      )}
    </div>
  );
}
