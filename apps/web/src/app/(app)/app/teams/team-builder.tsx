'use client';

import { useEffect, useRef, useState } from 'react';
import type { Locale, StudioAgentView, TeamMode, TeamRole, TeamView } from '@milyonuse/contracts';
import { Button, Field, Notice } from '@/components/ui/primitives';
import { getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';

interface Row {
  agentId: string;
  role: TeamRole;
  specialty: string;
}

const MODES: TeamMode[] = ['hierarchical', 'pipeline', 'debate'];
const ROLES: TeamRole[] = ['lead', 'member', 'reviewer'];

/**
 * Building or changing a team: name, purpose, way of working, budget, and the
 * roster — the person's own agents, one lead, at most one reviewer. The
 * server checks the same rules; the form only spares a round trip.
 */
export function TeamBuilder({
  locale,
  agents,
  team,
  onClose,
  onSaved,
}: {
  locale: Locale;
  agents: StudioAgentView[];
  team?: TeamView;
  onClose: () => void;
  onSaved: (team: TeamView) => void;
}) {
  const t = getDictionary(locale);
  const k = t.app.teams;
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(team?.name ?? '');
  const [purpose, setPurpose] = useState(team?.purpose ?? '');
  const [mode, setMode] = useState<TeamMode>(team?.mode ?? 'hierarchical');
  const [budget, setBudget] = useState(team?.budgetTokens ?? 400_000);
  const [rows, setRows] = useState<Row[]>(
    team?.members.map((m) => ({ agentId: m.agentId, role: m.role, specialty: m.specialty })) ??
      (agents[0] ? [{ agentId: agents[0].id, role: 'lead', specialty: '' }] : []),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const used = new Set(rows.map((r) => r.agentId));
  const free = agents.filter((a) => !used.has(a.id));
  const leads = rows.filter((r) => r.role === 'lead').length;
  const reviewers = rows.filter((r) => r.role === 'reviewer').length;
  const valid = name.trim() !== '' && rows.length > 0 && leads === 1 && reviewers <= 1;

  const change = (i: number, patch: Partial<Row>) => setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      purpose: purpose.trim(),
      mode,
      budgetTokens: budget,
      members: rows.map((r, i) => ({ agentId: r.agentId, role: r.role, position: i, specialty: r.specialty.trim() })),
    };
    const result = team
      ? await request<TeamView>(`/teams/${team.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      : await request<TeamView>('/teams', { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(body) });
    setBusy(false);
    if (!result.ok) {
      setError(messageFor(result.error, t));
      return;
    }
    onSaved(result.data);
  }

  return (
    <dialog ref={dialog} className="dialog dialog-wide" onClose={onClose} aria-labelledby="builder-title">
      <div className="dialog-head">
        <div>
          <p className="eyebrow">{k.eyebrow}</p>
          <h2 id="builder-title" className="dialog-title">
            {team ? team.name : k.builderTitle}
          </h2>
        </div>
        <Button size="sm" variant="ghost" onClick={() => dialog.current?.close()}>
          {k.cancel}
        </Button>
      </div>
      {agents.length === 0 ? (
        <Notice tone="review">{k.noAgents}</Notice>
      ) : (
        <form onSubmit={(e) => void save(e)} className="studio-form">
          <div className="studio-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
            <Field label={k.name}>
              <input className="control" value={name} maxLength={60} required onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={k.budget} hint={k.budgetHint}>
              <input className="control" type="number" min={10000} max={10000000} step={10000} value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
            </Field>
          </div>
          <Field label={k.purpose}>
            <input className="control" value={purpose} maxLength={1000} onChange={(e) => setPurpose(e.target.value)} />
          </Field>
          <div className="field" role="group" aria-label={k.mode}>
            <span className="field-label">{k.mode}</span>
            <div className="choices">
              {MODES.map((m) => (
                <button key={m} type="button" className="choice" aria-pressed={m === mode} onClick={() => setMode(m)}>
                  <span className="choice-label">{k.modes[m].label}</span>
                  <span className="choice-hint">{k.modes[m].hint}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span className="field-label">{k.members}</span>
            <span className="field-hint" style={{ marginTop: 0 }}>
              {k.membersHint}
            </span>
            <div className="roster" style={{ marginTop: 8 }}>
              {rows.map((row, i) => (
                <div key={row.agentId} className="roster-row">
                  <select className="control" aria-label={k.members} value={row.agentId} onChange={(e) => change(i, { agentId: e.target.value })}>
                    {agents
                      .filter((a) => a.id === row.agentId || !used.has(a.id))
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.avatar} {a.name}
                          {a.roleTitle ? ` — ${a.roleTitle}` : ''}
                        </option>
                      ))}
                  </select>
                  <select className="control" aria-label={k.roles[row.role]} value={row.role} onChange={(e) => change(i, { role: e.target.value as TeamRole })}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {k.roles[r]}
                      </option>
                    ))}
                  </select>
                  <input className="control" placeholder={k.specialty} value={row.specialty} maxLength={300} onChange={(e) => change(i, { specialty: e.target.value })} />
                  <Button size="sm" variant="ghost" type="button" disabled={rows.length === 1} onClick={() => setRows((list) => list.filter((_, j) => j !== i))}>
                    {k.remove}
                  </Button>
                </div>
              ))}
            </div>
            {free.length > 0 && rows.length < 8 && (
              <div style={{ marginTop: 8 }}>
                <Button size="sm" type="button" onClick={() => setRows((list) => [...list, { agentId: free[0]!.id, role: 'member', specialty: '' }])}>
                  {k.addMember}
                </Button>
              </div>
            )}
          </div>
          {error && <Notice tone="danger">{error}</Notice>}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button type="submit" variant="primary" disabled={busy || !valid}>
              {busy ? k.saving : k.save}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}
