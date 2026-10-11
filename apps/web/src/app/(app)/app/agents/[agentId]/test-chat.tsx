'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import type { AgentConversationSummary, AgentTurn, Locale } from '@milyonuse/contracts';
import { Button, Notice } from '@/components/ui/primitives';
import { getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';
import { MessageText } from '../../agent/message-text';

interface Line {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Trying an agent beside its editor: a real conversation with it — kept in
 * the Agent page — that always answers with the version saved now. Actions it
 * proposes wait on their cards there.
 */
export function TestChat({ locale, agentId }: { locale: Locale; agentId: string }) {
  const t = getDictionary(locale);
  const s = t.app.studio;
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposed, setProposed] = useState(false);
  const log = useRef<HTMLDivElement>(null);

  const scroll = () => requestAnimationFrame(() => log.current?.scrollTo({ top: log.current.scrollHeight }));

  async function send(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    setError(null);
    let id = conversationId;
    if (!id) {
      const created = await request<AgentConversationSummary>('/agent/conversations', {
        method: 'POST',
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ agentId, title: `${s.test} · ${new Date().toLocaleString(locale)}` }),
      });
      if (!created.ok) {
        setBusy(false);
        setError(messageFor(created.error, t));
        return;
      }
      id = created.data.id;
      setConversationId(id);
    }
    setDraft('');
    setLines((l) => [...l, { id: `local-${Date.now()}`, role: 'user', content }]);
    scroll();
    const result = await request<AgentTurn>(`/agent/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    });
    setBusy(false);
    if (!result.ok) {
      setError(messageFor(result.error, t));
      return;
    }
    const answers = result.data.messages.filter((m) => m.role === 'assistant' && m.content.trim());
    setLines((l) => [...l, ...answers.map((m) => ({ id: m.id, role: 'assistant' as const, content: m.content }))]);
    if (result.data.actions.some((a) => a.status === 'proposed')) setProposed(true);
    scroll();
  }

  return (
    <div className="test-chat">
      {lines.length > 0 && (
        <div className="test-chat-log" ref={log}>
          {lines.map((line) => (
            <div key={line.id} className="test-chat-msg" data-role={line.role}>
              {line.role === 'assistant' ? <MessageText text={line.content} /> : line.content}
            </div>
          ))}
        </div>
      )}
      {proposed && conversationId && (
        <Notice tone="review">
          {s.waitsOnCard}{' '}
          <Link href={`/app/agent?c=${conversationId}`} style={{ color: 'inherit' }}>
            {s.openInAgent}
          </Link>
        </Notice>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      <form onSubmit={(e) => void send(e)} style={{ display: 'grid', gap: 8 }}>
        <textarea
          className="control control-area"
          style={{ minHeight: 72 }}
          placeholder={s.testPlaceholder}
          value={draft}
          maxLength={8000}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {conversationId && (
            <>
              <Link className="pill pill-ghost pill-sm" href={`/app/agent?c=${conversationId}`}>
                {s.openInAgent}
              </Link>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={busy}
                onClick={() => {
                  setConversationId(null);
                  setLines([]);
                  setProposed(false);
                }}
              >
                {s.newTest}
              </Button>
            </>
          )}
          <Button size="sm" variant="primary" type="submit" disabled={busy || !draft.trim()}>
            {busy ? s.sending : s.send}
          </Button>
        </div>
      </form>
    </div>
  );
}
