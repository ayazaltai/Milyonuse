'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Locale, StudioAgentView, TeamTemplateView, TeamView } from '@milyonuse/contracts';
import { Button, Checkbox, Notice, PageHead, Panel, Tag } from '@/components/ui/primitives';
import { getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';
import { TeamBuilder } from './team-builder';

export function TeamsGallery({
  locale,
  initial,
  templates,
  agents,
}: {
  locale: Locale;
  initial: TeamView[];
  templates: TeamTemplateView[];
  agents: StudioAgentView[];
}) {
  const t = getDictionary(locale);
  const k = t.app.teams;
  const router = useRouter();
  const [teams, setTeams] = useState(initial);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);

  const shown = teams.filter((x) => showArchived || !x.archivedAt);

  async function fromTemplate(id: string): Promise<void> {
    setBusy(id);
    setError(null);
    const result = await request<TeamView>('/teams', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ template: id, locale: locale === 'tr' ? 'tr' : 'en' }),
    });
    if (!result.ok) {
      setBusy(null);
      setError(messageFor(result.error, t));
      return;
    }
    router.push(`/app/teams/${result.data.id}`);
  }

  async function setArchived(team: TeamView, archived: boolean): Promise<void> {
    setBusy(team.id);
    const result = await request<TeamView>(`/teams/${team.id}/${archived ? 'archive' : 'restore'}`, { method: 'POST' });
    setBusy(null);
    if (!result.ok) {
      setError(messageFor(result.error, t));
      return;
    }
    setTeams((list) => list.map((x) => (x.id === team.id ? result.data : x)));
  }

  return (
    <>
      <PageHead
        eyebrow={k.eyebrow}
        title={k.titleTop}
        accent={k.titleAccent}
        lead={k.lead}
        actions={
          <Button variant="primary" onClick={() => setBuilding(true)}>
            {k.fromAgents}
          </Button>
        }
      />
      <div className="flex flex-col gap-6">
        {error && <Notice tone="danger">{error}</Notice>}
        <Panel
          title={k.yours}
          actions={teams.some((x) => x.archivedAt) ? <Checkbox label={t.app.studio.showArchived} checked={showArchived} onChange={setShowArchived} /> : undefined}
        >
          {shown.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--w-50)' }}>{k.none}</p>
          ) : (
            <div className="app-cards">
              {shown.map((team) => (
                <article key={team.id} className="app-card" data-connected={team.archivedAt ? undefined : ''}>
                  <div className="studio-card-head">
                    <span className="avatars" aria-hidden>
                      {team.members.slice(0, 4).map((m) => (
                        <span key={m.agentId} className="studio-avatar">
                          {m.avatar}
                        </span>
                      ))}
                    </span>
                    <div style={{ marginLeft: 8 }}>
                      <p className="app-card-name">{team.name}</p>
                      <p className="app-card-text">{team.members.map((m) => m.name).join(', ')}</p>
                    </div>
                  </div>
                  {team.purpose && <p className="app-card-text">{team.purpose}</p>}
                  <div className="studio-meta">
                    <Tag>{k.modes[team.mode].label}</Tag>
                    <Tag>{k.runs(team.runs)}</Tag>
                    {team.archivedAt && <Tag tone="review">{k.archived}</Tag>}
                  </div>
                  <div className="app-card-actions">
                    {!team.archivedAt && (
                      <Link className="pill pill-primary pill-sm" href={`/app/teams/${team.id}`}>
                        {k.open}
                      </Link>
                    )}
                    <Button size="sm" variant="ghost" disabled={busy === team.id} onClick={() => void setArchived(team, !team.archivedAt)}>
                      {team.archivedAt ? k.restore : k.archive}
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </Panel>

        <Panel title={k.templates} description={k.templateHint}>
          <div className="app-cards">
            {templates.map((template) => (
              <article key={template.id} className="app-card">
                <div className="studio-card-head">
                  <span className="avatars" aria-hidden>
                    {template.members.map((m, i) => (
                      <span key={i} className="studio-avatar">
                        {m.avatar}
                      </span>
                    ))}
                  </span>
                  <p className="app-card-name" style={{ marginLeft: 8 }}>
                    {template.name}
                  </p>
                </div>
                <p className="app-card-text">{template.purpose}</p>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4, fontSize: 12.5, color: 'var(--w-60)' }}>
                  {template.members.map((m, i) => (
                    <li key={i}>
                      <span style={{ color: 'var(--w-80)' }}>{m.name}</span> · {m.roleTitle} — {k.roles[m.role]}
                    </li>
                  ))}
                </ul>
                <div className="app-card-actions">
                  <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void fromTemplate(template.id)}>
                    {busy === template.id ? k.creating : k.create}
                  </Button>
                  <Tag>{k.modes[template.mode].label}</Tag>
                </div>
              </article>
            ))}
          </div>
        </Panel>
      </div>
      {building && (
        <TeamBuilder
          locale={locale}
          agents={agents}
          onClose={() => setBuilding(false)}
          onSaved={(team) => {
            setBuilding(false);
            router.push(`/app/teams/${team.id}`);
          }}
        />
      )}
    </>
  );
}
