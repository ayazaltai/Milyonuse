'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Locale, StudioAgentView, StudioTemplateView } from '@milyonuse/contracts';
import { Button, Checkbox, Notice, PageHead, Panel, Tag } from '@/components/ui/primitives';
import { getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';

/** A fresh key per creation, so a double click makes one agent (the route is idempotent). */
const key = () => crypto.randomUUID();

export function StudioGallery({ locale, initial, templates }: { locale: Locale; initial: StudioAgentView[]; templates: StudioTemplateView[] }) {
  const t = getDictionary(locale);
  const s = t.app.studio;
  const router = useRouter();
  const [agents, setAgents] = useState(initial);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shown = agents.filter((a) => showArchived || !a.archivedAt);
  const anyArchived = agents.some((a) => a.archivedAt);

  async function create(template?: string): Promise<void> {
    setBusy(template ?? 'blank');
    setError(null);
    const result = await request<StudioAgentView>('/agents', {
      method: 'POST',
      headers: { 'idempotency-key': key() },
      body: JSON.stringify(template ? { template, locale: locale === 'tr' ? 'tr' : 'en' } : { locale: locale === 'tr' ? 'tr' : 'en' }),
    });
    if (!result.ok) {
      setBusy(null);
      setError(messageFor(result.error, t));
      return;
    }
    router.push(`/app/agents/${result.data.id}?created=1`);
  }

  async function setArchived(agent: StudioAgentView, archived: boolean): Promise<void> {
    setBusy(agent.id);
    const result = await request<StudioAgentView>(`/agents/${agent.id}/${archived ? 'archive' : 'restore'}`, { method: 'POST' });
    setBusy(null);
    if (!result.ok) {
      setError(messageFor(result.error, t));
      return;
    }
    setAgents((list) => list.map((a) => (a.id === agent.id ? result.data : a)));
  }

  return (
    <>
      <PageHead
        eyebrow={s.eyebrow}
        title={s.titleTop}
        accent={s.titleAccent}
        lead={s.lead}
        actions={
          <Button variant="primary" disabled={busy !== null} onClick={() => void create()}>
            {busy === 'blank' ? s.creating : s.fromNothing}
          </Button>
        }
      />
      <div className="flex flex-col gap-6">
        {error && <Notice tone="danger">{error}</Notice>}

        <Panel
          title={s.yours}
          actions={anyArchived ? <Checkbox label={s.showArchived} checked={showArchived} onChange={setShowArchived} /> : undefined}
        >
          {shown.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--w-50)' }}>{s.none}</p>
          ) : (
            <div className="app-cards">
              {shown.map((agent) => (
                <article key={agent.id} className="app-card" data-connected={agent.archivedAt ? undefined : ''}>
                  <div className="studio-card-head">
                    <span className="studio-avatar" aria-hidden>
                      {agent.avatar}
                    </span>
                    <div>
                      <p className="app-card-name">{agent.name}</p>
                      {agent.roleTitle && <p className="app-card-text">{agent.roleTitle}</p>}
                    </div>
                  </div>
                  <div className="studio-meta">
                    <Tag>{s.version(agent.current.version)}</Tag>
                    <Tag>{s.tiers[agent.current.modelTier]}</Tag>
                    <Tag>{s.conversations(agent.conversations)}</Tag>
                    {agent.archivedAt && <Tag tone="review">{s.archived}</Tag>}
                  </div>
                  <div className="app-card-actions">
                    {!agent.archivedAt && (
                      <Link className="pill pill-primary pill-sm" href={`/app/agent?agent=${agent.id}`}>
                        {s.talk}
                      </Link>
                    )}
                    {!agent.archivedAt && (
                      <Link className="pill pill-ghost pill-sm" href={`/app/agents/${agent.id}`}>
                        {s.edit}
                      </Link>
                    )}
                    <Button size="sm" variant="ghost" disabled={busy === agent.id} onClick={() => void setArchived(agent, !agent.archivedAt)}>
                      {agent.archivedAt ? s.restore : s.archive}
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </Panel>

        <Panel title={s.templates}>
          <div className="app-cards">
            {templates.map((template) => (
              <article key={template.id} className="app-card">
                <div className="studio-card-head">
                  <span className="studio-avatar" aria-hidden>
                    {template.avatar}
                  </span>
                  <div>
                    <p className="app-card-name">{template.roleTitle}</p>
                    <p className="app-card-text">{template.name}</p>
                  </div>
                </div>
                <p className="app-card-text">{template.description}</p>
                <div className="studio-meta">
                  <Tag>{s.tiers[template.definition.modelTier]}</Tag>
                  {template.skillNames.map((name) => (
                    <Tag key={name}>{name}</Tag>
                  ))}
                </div>
                <div className="app-card-actions">
                  <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void create(template.id)}>
                    {busy === template.id ? s.creating : s.create}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </Panel>
      </div>
    </>
  );
}
