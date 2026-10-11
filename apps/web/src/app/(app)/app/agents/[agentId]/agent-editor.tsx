'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type {
  AgentDefinition,
  Locale,
  SkillSummaryView,
  StudioAgentVersionView,
  StudioAgentView,
  StudioToolOption,
} from '@milyonuse/contracts';
import { Button, Checkbox, Field, Notice, PageHead, Panel, Tag } from '@/components/ui/primitives';
import { type Dictionary, getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';
import { TestChat } from './test-chat';

type Tone = 'pass' | 'danger' | 'neutral';

function definitionOf(v: StudioAgentVersionView): AgentDefinition {
  return {
    persona: v.persona,
    instructions: v.instructions,
    modelTier: v.modelTier,
    tools: v.tools,
    memoryScope: v.memoryScope,
    autonomy: v.autonomy,
    unattendedPolicy: v.unattendedPolicy,
    budgetTokens: v.budgetTokens,
    budgetSandboxMinutes: v.budgetSandboxMinutes,
    skills: v.skills,
  };
}

/**
 * The editor: identity changes in place; anything the agent *is* is saved as
 * a new version (the server writes none when nothing changed). The test chat
 * beside it always talks to the version saved now.
 */
export function AgentEditor({
  locale,
  initial,
  initialVersions,
  tools,
  skills,
  justCreated,
}: {
  locale: Locale;
  initial: StudioAgentView;
  initialVersions: StudioAgentVersionView[];
  tools: StudioToolOption[];
  skills: SkillSummaryView[];
  justCreated: boolean;
}) {
  const t = getDictionary(locale);
  const s = t.app.studio;
  const [agent, setAgent] = useState(initial);
  const [versions, setVersions] = useState(initialVersions);
  const [name, setName] = useState(initial.name);
  const [avatar, setAvatar] = useState(initial.avatar);
  const [roleTitle, setRoleTitle] = useState(initial.roleTitle);
  const [definition, setDefinition] = useState<AgentDefinition>(definitionOf(initial.current));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: Tone; text: string } | null>(justCreated ? { tone: 'pass', text: s.created } : null);

  // The page was opened just after creating: the query has done its job.
  useEffect(() => {
    if (justCreated) window.history.replaceState(null, '', `/app/agents/${initial.id}`);
  }, [justCreated, initial.id]);

  const set = <K extends keyof AgentDefinition>(field: K, value: AgentDefinition[K]) => setDefinition((d) => ({ ...d, [field]: value }));
  const toggle = (field: 'tools' | 'skills', value: string, on: boolean) =>
    setDefinition((d) => ({ ...d, [field]: on ? [...new Set([...d[field], value])] : d[field].filter((x) => x !== value) }));

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    const before = agent.current.version;
    const result = await request<StudioAgentView>(`/agents/${agent.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: name.trim(), avatar: avatar.trim(), roleTitle: roleTitle.trim(), definition, ...(note.trim() ? { note: note.trim() } : {}) }),
    });
    if (!result.ok) {
      setSaving(false);
      setMessage({ tone: 'danger', text: messageFor(result.error, t) });
      return;
    }
    const identityChanged = result.data.name !== agent.name || result.data.avatar !== agent.avatar || result.data.roleTitle !== agent.roleTitle;
    setAgent(result.data);
    setDefinition(definitionOf(result.data.current));
    if (result.data.current.version !== before) {
      const fresh = await request<{ items: StudioAgentVersionView[] }>(`/agents/${agent.id}/versions`);
      if (fresh.ok) setVersions(fresh.data.items);
      setNote('');
      setMessage({ tone: 'pass', text: s.saved(result.data.current.version) });
    } else {
      setMessage({ tone: identityChanged ? 'pass' : 'neutral', text: identityChanged ? s.savedIdentity : s.noChange });
    }
    setSaving(false);
  }

  const ownTools = tools.filter((o) => !o.provider);
  const appTools = tools.filter((o) => o.provider);

  return (
    <>
      <PageHead
        eyebrow={s.eyebrow}
        title={agent.name}
        accent={agent.roleTitle || s.version(agent.current.version)}
        actions={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link className="pill pill-ghost" href="/app/agents">
              {s.back}
            </Link>
            <Link className="pill pill-primary" href={`/app/agent?agent=${agent.id}`}>
              {s.talk}
            </Link>
          </div>
        }
      />
      <div className="studio-editor">
        <form className="studio-form" onSubmit={(e) => void save(e)}>
          {message && <Notice tone={message.tone}>{message.text}</Notice>}

          <Panel title={s.identity}>
            <div className="studio-form">
              <div className="studio-row">
                <Field label={s.avatar} hint={s.avatarHint}>
                  <input className="control" value={avatar} maxLength={8} required onChange={(e) => setAvatar(e.target.value)} />
                </Field>
                <Field label={s.name}>
                  <input className="control" value={name} maxLength={60} required onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label={s.roleTitle}>
                  <input className="control" value={roleTitle} maxLength={80} onChange={(e) => setRoleTitle(e.target.value)} />
                </Field>
              </div>
              <Field label={s.persona} hint={s.personaHint}>
                <textarea className="control control-area" value={definition.persona} maxLength={2000} onChange={(e) => set('persona', e.target.value)} />
              </Field>
              <Field label={s.instructions} hint={s.instructionsHint}>
                <textarea
                  className="control control-area"
                  style={{ minHeight: 180 }}
                  value={definition.instructions}
                  maxLength={8000}
                  onChange={(e) => set('instructions', e.target.value)}
                />
              </Field>
            </div>
          </Panel>

          <Panel title={s.behaviour}>
            <div className="studio-form">
              <Choices
                label={s.modelTier}
                value={definition.modelTier}
                options={(['fast', 'balanced', 'deep'] as const).map((v) => ({ value: v, label: s.tiers[v], hint: s.tierHints[v] }))}
                onChange={(v) => set('modelTier', v)}
              />
              <Choices
                label={s.autonomy}
                value={definition.autonomy}
                options={(['ask', 'auto'] as const).map((v) => ({ value: v, ...s.autonomies[v] }))}
                onChange={(v) => set('autonomy', v)}
              />
              <Choices
                label={s.unattended}
                value={definition.unattendedPolicy}
                options={(['safe_only', 'trusted'] as const).map((v) => ({ value: v, ...s.unattendedPolicies[v] }))}
                onChange={(v) => set('unattendedPolicy', v)}
              />
              <Choices
                label={s.memoryScope}
                value={definition.memoryScope}
                options={(['user', 'agent'] as const).map((v) => ({ value: v, ...s.memoryScopes[v] }))}
                onChange={(v) => set('memoryScope', v)}
              />
            </div>
          </Panel>

          <Panel title={s.tools} description={s.toolsHint}>
            <div className="studio-form">
              <ToolChecks t={t} options={ownTools} chosen={definition.tools} onToggle={(name, on) => toggle('tools', name, on)} />
              <ToolChecks t={t} options={appTools} chosen={definition.tools} onToggle={(name, on) => toggle('tools', name, on)} />
            </div>
          </Panel>

          <Panel title={s.skills} description={s.skillsHint}>
            {skills.length === 0 ? (
              <p style={{ margin: 0, fontSize: 13.5, color: 'var(--w-50)' }}>
                {s.noSkills}{' '}
                <Link href="/app/skills" style={{ color: 'var(--w-80)' }}>
                  {t.app.skills.title}
                </Link>
              </p>
            ) : (
              <div className="tool-list">
                {skills.map((skill) => (
                  <Checkbox
                    key={skill.id}
                    checked={definition.skills.includes(skill.id)}
                    onChange={(on) => toggle('skills', skill.id, on)}
                    label={
                      <>
                        {skill.title?.[locale === 'tr' ? 'tr' : 'en'] ?? skill.name}
                        {!skill.active && <span className="tool-risk" data-risk="caution">{t.app.skills.noActive}</span>}
                      </>
                    }
                  />
                ))}
              </div>
            )}
          </Panel>

          <Panel title={s.budget}>
            <div className="studio-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
              <Field label={s.budgetTokens} hint={s.budgetTokensHint}>
                <input
                  className="control"
                  type="number"
                  min={1000}
                  max={2000000}
                  step={1000}
                  value={definition.budgetTokens}
                  onChange={(e) => set('budgetTokens', Number(e.target.value))}
                />
              </Field>
              <Field label={s.budgetSandbox} hint={s.budgetSandboxHint}>
                <input
                  className="control"
                  type="number"
                  min={0}
                  max={120}
                  value={definition.budgetSandboxMinutes}
                  onChange={(e) => set('budgetSandboxMinutes', Number(e.target.value))}
                />
              </Field>
            </div>
          </Panel>

          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 260px' }}>
              <Field label={s.note}>
                <input className="control" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </div>
            <Button type="submit" variant="primary" disabled={saving || !name.trim() || !avatar.trim()}>
              {saving ? s.saving : s.save}
            </Button>
          </div>
        </form>

        <aside className="studio-aside">
          <Panel title={s.test} description={s.testHint}>
            <TestChat locale={locale} agentId={agent.id} />
          </Panel>
          <Panel title={s.history}>
            <ol className="version-list">
              {versions.map((v) => (
                <li key={v.id} data-current={v.id === agent.current.id ? '' : undefined}>
                  <span>
                    {s.version(v.version)} · {s.tiers[v.modelTier]} {v.id === agent.current.id && <Tag tone="pass">{s.current}</Tag>}
                  </span>
                  <span className="sub">{new Date(v.createdAt).toLocaleString(locale)}</span>
                  {v.note && <span className="sub">{v.note}</span>}
                </li>
              ))}
            </ol>
          </Panel>
        </aside>
      </div>
    </>
  );
}

function Choices<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: { value: V; label: string; hint: string }[];
  onChange: (value: V) => void;
}) {
  return (
    <div className="field" role="group" aria-label={label}>
      <span className="field-label">{label}</span>
      <div className="choices">
        {options.map((o) => (
          <button key={o.value} type="button" className="choice" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
            <span className="choice-label">{o.label}</span>
            <span className="choice-hint">{o.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ToolChecks({
  t,
  options,
  chosen,
  onToggle,
}: {
  t: Dictionary;
  options: StudioToolOption[];
  chosen: string[];
  onToggle: (name: string, on: boolean) => void;
}) {
  const s = t.app.studio;
  return (
    <div className="tool-list">
      {options.map((o) => (
        <Checkbox
          key={o.name}
          checked={chosen.includes(o.name)}
          onChange={(on) => onToggle(o.name, on)}
          label={
            <>
              {o.summary}
              <span className="tool-risk" data-risk={o.risk}>
                {s.risks[o.risk]}
              </span>
            </>
          }
        />
      ))}
    </div>
  );
}
