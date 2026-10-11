'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { Locale, SkillCatalogueEntry, SkillDetailView, SkillSummaryView, SkillVersionView } from '@milyonuse/contracts';
import { Button, Checkbox, Field, Notice, PageHead, Panel, Tag } from '@/components/ui/primitives';
import { type Dictionary, getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';

type Tone = 'pass' | 'danger' | 'review';

/** A summary from a detail: the list and the dialog stay in step after every decision. */
function summaryOf(d: SkillDetailView): SkillSummaryView {
  return { id: d.id, name: d.name, source: d.source, enabled: d.enabled, active: d.active, staging: d.staging, title: d.title, updatedAt: d.updatedAt };
}

export function SkillsBoard({ locale, initial, catalogue: initialCatalogue }: { locale: Locale; initial: SkillSummaryView[]; catalogue: SkillCatalogueEntry[] }) {
  const t = getDictionary(locale);
  const k = t.app.skills;
  const lang = locale === 'tr' ? 'tr' : 'en';
  const [skills, setSkills] = useState(initial);
  const [catalogue, setCatalogue] = useState(initialCatalogue);
  const [message, setMessage] = useState<{ tone: Tone; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<SkillDetailView | null>(null);
  const [writing, setWriting] = useState(false);

  const replaying = skills.some((s) => s.staging && !s.staging.replayed);

  // A replay runs in the queue: while one is pending, the list looks again now and then.
  useEffect(() => {
    if (!replaying) return;
    const timer = setInterval(() => {
      void request<{ items: SkillSummaryView[] }>('/skills').then((r) => {
        if (r.ok) setSkills(r.data.items);
      });
    }, 4000);
    return () => clearInterval(timer);
  }, [replaying]);

  function apply(detail: SkillDetailView): void {
    setSkills((list) => {
      const next = summaryOf(detail);
      return list.some((s) => s.id === next.id) ? list.map((s) => (s.id === next.id ? next : s)) : [...list, next].sort((a, b) => a.name.localeCompare(b.name));
    });
    setOpen((o) => (o && o.id === detail.id ? detail : o));
  }

  async function act(id: string, path: string, init: RequestInit, done?: string): Promise<SkillDetailView | null> {
    setBusy(id);
    setMessage(null);
    const result = await request<SkillDetailView>(path, init);
    setBusy(null);
    if (!result.ok) {
      setMessage({ tone: 'danger', text: messageFor(result.error, t) });
      return null;
    }
    apply(result.data);
    if (done) setMessage({ tone: 'pass', text: done });
    return result.data;
  }

  async function add(name: string): Promise<void> {
    const added = await act(name, '/skills/bundled', { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ name }) });
    if (added) setCatalogue((list) => list.map((e) => (e.name === name ? { ...e, added: true } : e)));
  }

  async function details(id: string): Promise<void> {
    const result = await request<SkillDetailView>(`/skills/${id}`);
    if (result.ok) setOpen(result.data);
    else setMessage({ tone: 'danger', text: messageFor(result.error, t) });
  }

  const decide = (skill: SkillSummaryView, verb: 'approve' | 'reject' | 'replay') =>
    act(
      skill.id,
      `/skills/versions/${skill.staging!.id}/${verb}`,
      { method: 'POST', body: '{}' },
      verb === 'approve' ? k.approved : verb === 'reject' ? k.rejected : k.replayQueued,
    );

  return (
    <>
      <PageHead
        eyebrow={k.eyebrow}
        title={k.titleTop}
        accent={k.titleAccent}
        lead={k.lead}
        actions={
          <Button variant="primary" onClick={() => setWriting(true)}>
            {k.write}
          </Button>
        }
      />
      <div className="flex flex-col gap-6">
        {message && <Notice tone={message.tone}>{message.text}</Notice>}

        <Panel title={k.yours}>
          {skills.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--w-50)' }}>{k.none}</p>
          ) : (
            <div className="skill-rows">
              {skills.map((skill) => (
                <SkillRow
                  key={skill.id}
                  t={t}
                  lang={lang}
                  skill={skill}
                  busy={busy === skill.id}
                  onToggle={() =>
                    void act(skill.id, `/skills/${skill.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !skill.enabled }) })
                  }
                  onDecide={(verb) => void decide(skill, verb)}
                  onOpen={() => void details(skill.id)}
                />
              ))}
            </div>
          )}
        </Panel>

        <Panel title={k.catalogue} description={k.catalogueHint}>
          <div className="app-cards">
            {catalogue.map((entry) => (
              <article key={entry.name} className="app-card">
                <p className="app-card-name">{entry.title[lang]}</p>
                <p className="app-card-text">{entry.summary[lang]}</p>
                <div className="app-card-actions">
                  {entry.added ? (
                    <Tag tone="pass">{k.added}</Tag>
                  ) : (
                    <Button size="sm" variant="primary" disabled={busy === entry.name} onClick={() => void add(entry.name)}>
                      {k.add}
                    </Button>
                  )}
                  <Tag>{entry.category}</Tag>
                </div>
              </article>
            ))}
          </div>
        </Panel>
      </div>

      {open && (
        <SkillDialog
          t={t}
          locale={locale}
          skill={open}
          busy={busy === open.id}
          onClose={() => setOpen(null)}
          onDecide={(verb) => void decide(summaryOf(open), verb)}
        />
      )}
      {writing && (
        <WriteDialog
          t={t}
          onClose={() => setWriting(false)}
          onStaged={(detail) => {
            apply(detail);
            setWriting(false);
            setMessage({ tone: 'pass', text: k.staged });
          }}
        />
      )}
    </>
  );
}

function SkillRow({
  t,
  lang,
  skill,
  busy,
  onToggle,
  onDecide,
  onOpen,
}: {
  t: Dictionary;
  lang: 'en' | 'tr';
  skill: SkillSummaryView;
  busy: boolean;
  onToggle: () => void;
  onDecide: (verb: 'approve' | 'reject' | 'replay') => void;
  onOpen: () => void;
}) {
  const k = t.app.skills;
  const staging = skill.staging;
  return (
    <article className="skill-row" data-waiting={staging ? '' : undefined}>
      <div style={{ minWidth: 0 }}>
        <div className="studio-meta" style={{ alignItems: 'center' }}>
          <p className="skill-row-name">{skill.title?.[lang] ?? skill.name}</p>
          <Tag>{k.sources[skill.source]}</Tag>
          {skill.active ? <Tag tone="pass">{k.active(skill.active.version)}</Tag> : <Tag>{k.noActive}</Tag>}
          {!skill.enabled && <Tag tone="review">{k.disabled}</Tag>}
          {staging && (
            <Tag tone={staging.replayed ? (staging.passed ? 'pass' : 'danger') : 'review'}>
              {k.waiting(staging.version)} · {staging.replayed ? (staging.passed ? k.replayPassed : k.replayFailed) : k.replaying}
            </Tag>
          )}
        </div>
        <p className="skill-row-text">{(staging ?? skill.active)?.description ?? skill.name}</p>
      </div>
      <div className="skill-row-actions">
        {staging?.replayed && staging.passed && (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onDecide('approve')}>
            {k.approve}
          </Button>
        )}
        {staging?.replayed && !staging.passed && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide('replay')}>
            {k.replayAgain}
          </Button>
        )}
        {staging && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide('reject')}>
            {k.reject}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onToggle}>
          {skill.enabled ? k.turnOff : k.turnOn}
        </Button>
        <Button size="sm" variant="ghost" onClick={onOpen}>
          {k.open}
        </Button>
      </div>
    </article>
  );
}

/** Every version: what it says, what the scanner found, where it came from, and the replay evidence. */
function SkillDialog({
  t,
  locale,
  skill,
  busy,
  onClose,
  onDecide,
}: {
  t: Dictionary;
  locale: Locale;
  skill: SkillDetailView;
  busy: boolean;
  onClose: () => void;
  onDecide: (verb: 'approve' | 'reject' | 'replay') => void;
}) {
  const k = t.app.skills;
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog ref={dialog} className="dialog dialog-wide" onClose={onClose} aria-labelledby="skill-title">
      <div className="dialog-head">
        <div>
          <p className="eyebrow">{k.sources[skill.source]}</p>
          <h2 id="skill-title" className="dialog-title">
            {skill.title?.[locale === 'tr' ? 'tr' : 'en'] ?? skill.name}
          </h2>
        </div>
        <Button size="sm" variant="ghost" onClick={() => dialog.current?.close()}>
          {k.close}
        </Button>
      </div>
      <div style={{ display: 'grid', gap: 18 }}>
        {skill.versions.map((v) => (
          <Version key={v.id} t={t} locale={locale} version={v} busy={busy} onDecide={onDecide} />
        ))}
      </div>
    </dialog>
  );
}

function Version({
  t,
  locale,
  version: v,
  busy,
  onDecide,
}: {
  t: Dictionary;
  locale: Locale;
  version: SkillVersionView;
  busy: boolean;
  onDecide: (verb: 'approve' | 'reject' | 'replay') => void;
}) {
  const k = t.app.skills;
  const passed = v.runs[0]?.passed === true;
  const verdictTone = v.scanVerdict === 'clean' ? 'pass' : v.scanVerdict === 'danger' ? 'danger' : 'review';
  return (
    <Panel
      title={`v${v.version} · ${k.states[v.state]}`}
      description={v.description}
      actions={
        v.state === 'staging' ? (
          <div className="app-card-actions">
            {passed && (
              <Button size="sm" variant="primary" disabled={busy} onClick={() => onDecide('approve')}>
                {k.approve}
              </Button>
            )}
            {v.runs.length > 0 && !passed && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide('replay')}>
                {k.replayAgain}
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide('reject')}>
              {k.reject}
            </Button>
          </div>
        ) : undefined
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <dl className="kv">
          <dt>{k.findings}</dt>
          <dd>
            <Tag tone={verdictTone}>{k.verdicts[v.scanVerdict]}</Tag>
            {v.findings.length > 0 && <span style={{ marginLeft: 8 }}>{v.findings.map((f) => f.detail).join(' · ')}</span>}
          </dd>
          {v.stateReason && (
            <>
              <dt>{k.states[v.state]}</dt>
              <dd>{v.stateReason}</dd>
            </>
          )}
          {v.approvedByPolicy && (
            <>
              <dt>{k.approve}</dt>
              <dd>{k.approvedByPolicy}</dd>
            </>
          )}
          {v.task && (
            <>
              <dt>{k.task}</dt>
              <dd>
                {v.task}
                {v.sourceConversationId && (
                  <>
                    {' · '}
                    <Link href={`/app/agent?c=${v.sourceConversationId}`} style={{ color: 'var(--w-80)' }}>
                      {k.conversation}
                    </Link>
                  </>
                )}
              </dd>
            </>
          )}
          {v.derivedFrom.length > 0 && (
            <>
              <dt>{k.derivedFrom}</dt>
              <dd>{v.derivedFrom.join(' · ')}</dd>
            </>
          )}
          {v.files.length > 0 && (
            <>
              <dt>{k.files}</dt>
              <dd>{v.files.map((f) => f.path).join(' · ')}</dd>
            </>
          )}
          <dt>{k.runs}</dt>
          <dd>
            {v.runs.length === 0 ? (
              k.noRuns
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
                {v.runs.map((r) => (
                  <li key={r.id}>
                    <Tag tone={r.passed ? 'pass' : 'danger'}>{r.passed ? k.replayPassed : k.replayFailed}</Tag>{' '}
                    <span style={{ color: 'var(--w-50)' }}>
                      {k.evaluators[r.evaluator]}
                      {r.score !== null && ` · ${k.score(r.score)}`} · {new Date(r.createdAt).toLocaleString(locale)}
                    </span>
                    <div style={{ marginTop: 4 }}>{r.verdict}</div>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--w-60)' }}>{k.content}</summary>
          <pre className="code-block" style={{ marginTop: 10 }}>
            {v.content}
          </pre>
        </details>
      </div>
    </Panel>
  );
}

/** Writing a skill: scanned on the server; a caution comes back with its findings and the choice to keep it anyway. */
function WriteDialog({ t, onClose, onStaged }: { t: Dictionary; onClose: () => void; onStaged: (d: SkillDetailView) => void }) {
  const k = t.app.skills;
  const dialog = useRef<HTMLDialogElement>(null);
  const [content, setContent] = useState('');
  const [force, setForce] = useState(false);
  const [caution, setCaution] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await request<SkillDetailView>('/skills', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ content, force }),
    });
    setBusy(false);
    if (!result.ok) {
      // A caution is a conflict the person may overrule; anything else is refused.
      if (result.error.code === 'conflict') setCaution(true);
      setError(messageFor(result.error, t));
      return;
    }
    onStaged(result.data);
  }

  return (
    <dialog ref={dialog} className="dialog dialog-wide" onClose={onClose} aria-labelledby="write-title">
      <div className="dialog-head">
        <div>
          <p className="eyebrow">{k.eyebrow}</p>
          <h2 id="write-title" className="dialog-title">
            {k.writeTitle}
          </h2>
        </div>
        <Button size="sm" variant="ghost" onClick={() => dialog.current?.close()}>
          {k.cancel}
        </Button>
      </div>
      <form onSubmit={(e) => void submit(e)} style={{ display: 'grid', gap: 14 }}>
        <Field label="SKILL.md" hint={k.writeHint}>
          <textarea
            className="control control-area control-code"
            style={{ minHeight: 280 }}
            placeholder={k.writePlaceholder}
            value={content}
            maxLength={50000}
            required
            onChange={(e) => {
              setContent(e.target.value);
              setCaution(false);
              setForce(false);
            }}
          />
        </Field>
        {error && <Notice tone={caution ? 'review' : 'danger'}>{error}</Notice>}
        {caution && <Checkbox label={k.keepAnyway} checked={force} onChange={setForce} />}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="submit" variant="primary" disabled={busy || !content.trim() || (caution && !force)}>
            {busy ? k.submitting : k.submit}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
