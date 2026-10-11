'use client';

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AGENT_MODES,
  type AgentActionView,
  type AgentAttachmentView,
  type AgentCompaction,
  type AgentConversationSummary,
  type AgentConversationView,
  type AgentMessageView,
  type AgentMode,
  type AgentSearchHit,
  type AgentStatus,
  type AgentStreamEvent,
  type AgentTurn,
  type Locale,
  agentSupersededIds,
} from '@milyonuse/contracts';
import { type Dictionary, getDictionary } from '@/i18n';
import { request, stream, upload } from '@/lib/client-api';
import { ActionCard, actionIdOf } from './action-card';
import { type AgentView, DataCard, type LiveStep, StepsCard, ViewMenu, presentedOf, useAgentView } from './agent-cards';
import { Composer, DeleteDialog, DetailsDialog, Mark, Menu, type MenuEntry, RenameDialog, When } from './agent-parts';
import { MessageText } from './message-text';

/**
 * The agent's workspace (ported from App-Milyonus
 * `(dashboard)/agent/agent-console.tsx`, made general-purpose).
 *
 * A thread rail, one stage, one composer. An empty stage greets the reader
 * and offers work to start from; a conversation reads like a document, with
 * the agent's steps and the data it laid out as cards. The turn streams: the
 * reader sees each step and the answer as it is written, and can stop it.
 */

/** Where the chosen mode is kept, per browser. */
const MODE_KEY = 'milyonuse.agent.mode';
const PATH = '/app/agent';

type Group = keyof Dictionary['app']['agent']['groups'];
const GROUP_ORDER: Group[] = ['pinned', 'today', 'week', 'month', 'older'];

function key(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

/** The rail's groups, as a chat app draws them. */
function groupOf(c: AgentConversationSummary): Group {
  if (c.pinnedAt) return 'pinned';
  const at = new Date(c.lastMessageAt);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  if (at >= startOfToday) return 'today';
  const age = Date.now() - at.getTime();
  const day = 86_400_000;
  if (age < 7 * day) return 'week';
  if (age < 30 * day) return 'month';
  return 'older';
}

/** The reader's own zone, sent with every message so a time they give is read in it. */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

type DialogState = { kind: 'rename' | 'delete'; conversation: AgentConversationSummary } | { kind: 'details' } | null;

export function AgentConsole({
  locale,
  status,
  conversations: initialConversations,
  initial,
}: {
  locale: Locale;
  status: AgentStatus;
  conversations: AgentConversationSummary[];
  initial: AgentConversationView | null;
}) {
  const t = getDictionary(locale);
  const a = t.app.agent;
  const number = new Intl.NumberFormat(locale);

  const [conversations, setConversations] = useState(initialConversations);
  const [current, setCurrent] = useState<AgentConversationView | null>(initial);
  const [model, setModel] = useState(initial?.conversation.model ?? status.defaultModel);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<AgentAttachmentView[]>([]);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [thinking, setThinking] = useState(0);
  /** The person's message came back on the stream: the thread shows it, not the placeholder. */
  const [echoed, setEchoed] = useState(false);
  /** Steps of the agent's current round, as they happen. */
  const [live, setLive] = useState<LiveStep[]>([]);
  /** The agent's answer of the current round, as it is written. */
  const [written, setWritten] = useState<{ round: number; text: string } | null>(null);
  const [view, changeView] = useAgentView();
  const [uploading, setUploading] = useState(false);
  const [alert, setAlert] = useState<{ title: string; body: string; tone?: 'review' } | null>(null);
  const [rail, setRail] = useState<'open' | 'closed'>('open');
  const [search, setSearch] = useState('');
  /** Words found inside conversations, and the message to bring into view once opened. */
  const [hits, setHits] = useState<AgentSearchHit[]>([]);
  const [found, setFound] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ anchor: DOMRect; entries: MenuEntry[]; forId?: string } | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [toast, setToast] = useState<{ text: string; n: number } | null>(null);
  // Today's allowance, read again after every turn so it is never a turn behind.
  const [allowance, setAllowance] = useState(status.allowance);
  /** Mounted in the browser: the greeting is said again by the reader's own clock. */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  /** How the agent works, as this person last chose it in this browser. */
  const [mode, setMode] = useState<AgentMode>('ask');
  /** An action proposed, run or changed — its card is replaced where it is, or added. */
  const upsertAction = useCallback((action: AgentActionView) => {
    setCurrent((c) => {
      if (!c || c.conversation.id !== action.conversationId) return c;
      const actions = c.actions;
      return {
        ...c,
        actions: actions.some((x) => x.id === action.id) ? actions.map((x) => (x.id === action.id ? action : x)) : [...actions, action],
      };
    });
  }, []);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(MODE_KEY);
      if (saved === 'ask' || saved === 'auto' || saved === 'plan') setMode(saved);
    } catch {
      // Storage refused (a private window): Ask.
    }
  }, []);
  function pickMode(next: AgentMode): void {
    setMode(next);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      // Kept for this page only.
    }
  }
  // Where the list floats over the thread (tokens.css, ≤ 1100 px), it starts closed and closes once a
  // conversation is picked: the thread is what a phone has room for.
  const narrow = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 1100px)').matches;
  useEffect(() => {
    if (narrow()) setRail('closed');
  }, []);
  /** Stop was pressed and the turn has not ended yet. */
  const [stopping, setStopping] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const disabled = !status.configured;

  // ── effects ──────────────────────────────────────────────────────────
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [current?.messages.length, current?.conversation.id, waiting, alert, written?.text]);

  useEffect(() => {
    if (!waiting) return;
    setThinking(0);
    const timer = setInterval(() => setThinking((n) => (n + 1) % a.thinking.length), 2200);
    return () => clearInterval(timer);
  }, [waiting, a.thinking.length]);

  // The rail's search reads inside messages too, once two characters are typed.
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void request<{ items: AgentSearchHit[] }>(`/agent/search?q=${encodeURIComponent(q)}`).then((r) => {
        if (r.ok) setHits(r.data.items);
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  // A message found by search is brought into view after the thread has scrolled to its end.
  useEffect(() => {
    if (!found || !current) return;
    const timer = window.setTimeout(() => {
      const el = document.getElementById(`m-${found}`);
      if (el) {
        el.scrollIntoView({ block: 'center' });
        el.setAttribute('data-found', '');
        window.setTimeout(() => el.removeAttribute('data-found'), 2400);
      }
      setFound(null);
    }, 60);
    return () => window.clearTimeout(timer);
  }, [found, current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        show(null);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        setRail((r) => (r === 'open' ? 'closed' : 'open'));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // Registered once: `show` only sets state and the address.
  }, []);

  function notify(text: string): void {
    setToast({ text, n: Date.now() });
  }
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  /** What went wrong, said for the person in front of it. */
  function explain(error: { code: string; message: string }): { title: string; body: string } {
    const al = a.alert;
    if (error.code === 'budget_exceeded') return { title: al.budgetTitle, body: error.message };
    if (error.code === 'stream_interrupted') return { title: al.droppedTitle, body: al.droppedBody };
    if (error.code === 'rate_limited') return { title: al.busyTitle, body: al.busyBody };
    if (error.code === 'file_too_large') return { title: al.failedTitle, body: al.tooLarge };
    if (error.code === 'network') return { title: al.failedTitle, body: t.errors.network };
    return { title: al.failedTitle, body: error.message || t.errors.generic };
  }

  // ── navigation ───────────────────────────────────────────────────────
  function show(next: AgentConversationView | null): void {
    setCurrent(next);
    setPending([]);
    setAlert(null);
    setDialog(null);
    if (next) setModel(next.conversation.model);
    else setDraft('');
    if (narrow()) setRail('closed');
    // The address follows the conversation, so a reload opens the same one.
    window.history.replaceState(null, '', next ? `${PATH}?c=${next.conversation.id}` : PATH);
  }

  async function open(id: string): Promise<AgentConversationView | null> {
    if (current?.conversation.id === id) return current;
    const result = await request<AgentConversationView>(`/agent/conversations/${id}`);
    if (!result.ok) {
      notify(explain(result.error).body);
      return null;
    }
    show(result.data);
    return result.data;
  }

  function replaceSummary(next: AgentConversationSummary): void {
    setConversations((list) => list.map((x) => (x.id === next.id ? next : x)));
    setCurrent((c) => (c && c.conversation.id === next.id ? { ...c, conversation: next } : c));
  }

  // ── conversation changes ─────────────────────────────────────────────
  async function patch(id: string, body: { title?: string; model?: string; pinned?: boolean }): Promise<boolean> {
    const result = await request<AgentConversationSummary>(`/agent/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    if (!result.ok) {
      notify(explain(result.error).body);
      return false;
    }
    replaceSummary(result.data);
    return true;
  }

  async function pickModel(id: string): Promise<void> {
    setModel(id);
    if (current) await patch(current.conversation.id, { model: id });
  }

  async function remove(conversation: AgentConversationSummary): Promise<void> {
    const result = await request(`/agent/conversations/${conversation.id}`, { method: 'DELETE' });
    setDialog(null);
    if (!result.ok) {
      notify(explain(result.error).body);
      return;
    }
    setConversations((list) => list.filter((x) => x.id !== conversation.id));
    if (current?.conversation.id === conversation.id) show(null);
    notify(a.toast.deleted);
  }

  // ── a turn ───────────────────────────────────────────────────────────
  /** The conversation to write in — made on the first message, with the chosen model. */
  async function ensure(): Promise<AgentConversationView | null> {
    if (current) return current;
    const result = await request<AgentConversationSummary>('/agent/conversations', {
      method: 'POST',
      headers: { 'idempotency-key': key() },
      body: JSON.stringify({ model }),
    });
    if (!result.ok) {
      setAlert(explain(result.error));
      return null;
    }
    const fresh: AgentConversationView = { conversation: result.data, memory: null, messages: [], attachments: [], actions: [] };
    setConversations((list) => [result.data, ...list]);
    setCurrent(fresh);
    window.history.replaceState(null, '', `${PATH}?c=${result.data.id}`);
    return fresh;
  }

  /** Sends a message — or, with `revises`, an edit of an earlier one, or the same words asked again. */
  async function send(text = draft, revises?: string): Promise<void> {
    const content = text.trim();
    if (!content || waiting !== null) return;
    // A command, not a message: the agent summarises the conversation so far.
    if (!revises && content.toLowerCase() === '/compact') {
      setDraft('');
      await compact();
      return;
    }
    const conversation = await ensure();
    if (!conversation) return;
    const handed = pending;
    setWaiting(content);
    setDraft('');
    setPending([]);
    setAlert(null);
    setEchoed(false);
    setLive([]);
    setWritten(null);
    const body = {
      content,
      attachmentIds: handed.map((p) => p.id),
      timeZone: browserTimeZone(),
      mode,
      ...(revises ? { revises } : {}),
    };
    // What the conversation held before this message — to tell, if the stream fails, whether it arrived.
    const before = new Set(conversation.messages.map((m) => m.id));
    let finished: AgentTurn | null = null;
    let failure: { code: string; message: string } | null = null;
    let userEchoed = false;
    const appendMessage = (m: AgentMessageView) =>
      setCurrent((c) => (c && !c.messages.some((x) => x.id === m.id) ? { ...c, messages: [...c.messages, m] } : c));

    const streamed = await stream<AgentStreamEvent>(
      `/agent/conversations/${conversation.conversation.id}/messages/stream`,
      body,
      (event) => {
        if (event.type === 'message') {
          const m = event.message;
          if (m.role === 'user') {
            userEchoed = true;
            setEchoed(true);
          }
          if (m.role === 'assistant') {
            setLive([]);
            setWritten(null);
          }
          if (m.role === 'tool') setLive((l) => l.map((x, i) => (i === l.length - 1 ? { ...x, done: true } : x)));
          appendMessage(m);
        } else if (event.type === 'text') {
          setWritten((w) =>
            w && w.round === event.round ? { round: w.round, text: w.text + event.text } : { round: event.round, text: event.text },
          );
        } else if (event.type === 'action') {
          upsertAction(event.action);
        } else if (event.type === 'step') {
          setLive((l) => [...l.map((x) => ({ ...x, done: true })), { summary: event.summary, done: false }]);
        } else if (event.type === 'done') {
          finished = event.turn;
        } else {
          failure = { code: event.code, message: event.message };
        }
      },
    );

    // The stream failed before its first event — say, a proxy that does not pass it. The server
    // may still have the message: look before sending it again, so it is never answered twice.
    if (!streamed.ok && !streamed.opened && streamed.error.code === 'network') {
      const look = await request<AgentConversationView>(`/agent/conversations/${conversation.conversation.id}`);
      const arrived =
        look.ok && look.data.messages.some((m) => m.role === 'user' && !before.has(m.id) && m.content === content);
      if (arrived) {
        userEchoed = true;
        failure = { code: 'stream_interrupted', message: '' };
      } else if (!look.ok && look.error.code === 'network') {
        failure = look.error;
      } else {
        const result = await request<AgentTurn>(`/agent/conversations/${conversation.conversation.id}/messages`, {
          method: 'POST',
          headers: { 'idempotency-key': key() },
          body: JSON.stringify(body),
        });
        if (result.ok) finished = result.data;
        else failure = result.error;
      }
    } else if (!streamed.ok) {
      failure = streamed.error;
    }

    setWaiting(null);
    setLive([]);
    setWritten(null);
    setStopping(false);
    const turn = finished as AgentTurn | null;
    if (!turn) {
      setAlert(explain(failure ?? { code: 'internal_error', message: a.alert.answerStopped }));
      if (!userEchoed) {
        setDraft(content);
        setPending(handed);
      }
      // Whatever was written before it stopped is kept; show it.
      const fresh = await request<AgentConversationView>(`/agent/conversations/${conversation.conversation.id}`);
      if (fresh.ok) setCurrent(fresh.data);
      return;
    }
    const known = (ids: { id: string }[], id: string) => ids.some((x) => x.id === id);
    setCurrent((c) =>
      c
        ? {
            ...c,
            conversation: turn.conversation,
            messages: [...c.messages, ...turn.messages.filter((m) => !known(c.messages, m.id))],
          }
        : c,
    );
    setConversations((list) => [turn.conversation, ...list.filter((x) => x.id !== turn.conversation.id)]);
    void request<AgentStatus>('/agent').then((fresh) => fresh.ok && setAllowance(fresh.data.allowance));
    if (turn.stopped === 'stopped') setAlert({ title: a.alert.stoppedTitle, body: a.alert.stoppedBody });
    else if (turn.stopped) setAlert({ title: a.alert.pausedTitle, body: a.alert.paused[turn.stopped], tone: 'review' });
  }

  /**
   * /compact: the agent summarises the conversation so far and reads that
   * summary from now on. Every message stays on the page; a divider marks
   * where the summary ends.
   */
  async function compact(target: AgentConversationView | null = current): Promise<void> {
    if (!target || waiting !== null) return;
    if (target.messages.length === 0) {
      notify(a.toast.nothingToSummarise);
      return;
    }
    const id = target.conversation.id;
    setWaiting('/compact');
    setEchoed(true);
    setLive([{ summary: a.menu.compact, done: false }]);
    setAlert(null);
    const result = await request<AgentCompaction>(`/agent/conversations/${id}/compact`, {
      method: 'POST',
      headers: { 'idempotency-key': key() },
    });
    setWaiting(null);
    setLive([]);
    if (!result.ok) {
      setAlert(explain(result.error));
      return;
    }
    setCurrent((c) =>
      c && c.conversation.id === id ? { ...c, conversation: result.data.conversation, memory: result.data.memory } : c,
    );
    replaceSummary(result.data.conversation);
    notify(a.toast.summarised(number.format(result.data.messages), result.data.messages === 1));
  }

  /** Asks the running turn to stop; it ends at its next safe point, keeping what it did. */
  async function stop(): Promise<void> {
    if (!current || stopping) return;
    setStopping(true);
    const result = await request(`/agent/conversations/${current.conversation.id}/stop`, { method: 'POST' });
    if (!result.ok) {
      setStopping(false);
      notify(explain(result.error).body);
    }
  }

  async function attachFile(file: File): Promise<void> {
    const conversation = await ensure();
    if (!conversation) return;
    setUploading(true);
    const result = await upload<AgentAttachmentView>(
      `/agent/conversations/${conversation.conversation.id}/attachments`,
      file,
      file.name,
    );
    setUploading(false);
    if (!result.ok) {
      setAlert(explain(result.error));
      return;
    }
    setPending((list) => [...list, result.data]);
    notify(
      result.data.kind === 'document'
        ? a.toast.attachedDocument(result.data.name)
        : a.toast.attachedTable(result.data.name, number.format(result.data.rowCount)),
    );
  }

  async function attachPaste(text: string): Promise<void> {
    const conversation = await ensure();
    if (!conversation) return;
    setUploading(true);
    const result = await request<AgentAttachmentView>(`/agent/conversations/${conversation.conversation.id}/attachments`, {
      method: 'POST',
      headers: { 'idempotency-key': key() },
      body: JSON.stringify({ name: a.toast.pastedTable, text }),
    });
    setUploading(false);
    if (!result.ok) {
      setAlert(explain(result.error));
      return;
    }
    setPending((list) => [...list, result.data]);
    notify(a.toast.attachedTable(result.data.name, number.format(result.data.rowCount)));
  }

  /** The reader's rating of an answer, kept on the message so the thread shows it. */
  async function rate(messageId: string, rating: 1 | -1, note: string): Promise<boolean> {
    const result = await request(`/agent/messages/${messageId}/feedback`, {
      method: 'PUT',
      body: JSON.stringify({ rating, note }),
    });
    if (!result.ok) {
      notify(explain(result.error).body);
      return false;
    }
    setCurrent((c) => (c ? { ...c, messages: c.messages.map((m) => (m.id === messageId ? { ...m, rating } : m)) } : c));
    notify(note ? a.toast.noted : a.toast.thanks);
    return true;
  }

  // ── menus ────────────────────────────────────────────────────────────
  function threadMenu(anchor: HTMLElement, c: AgentConversationSummary): void {
    const m = a.menu;
    const entries: MenuEntry[] = [
      { label: m.rename, onSelect: () => setDialog({ kind: 'rename', conversation: c }) },
      {
        label: c.pinnedAt ? m.unpin : m.pin,
        onSelect: () =>
          void patch(c.id, { pinned: !c.pinnedAt }).then((ok) => ok && notify(c.pinnedAt ? a.toast.unpinned : a.toast.pinned)),
      },
      { label: m.details, onSelect: () => void open(c.id).then((v) => v && setDialog({ kind: 'details' })) },
      { label: m.compact, onSelect: () => void open(c.id).then((v) => v && compact(v)) },
      {
        // The download is the server's, and audited.
        label: m.export,
        onSelect: () => {
          const link = document.createElement('a');
          link.href = `/api/v1/agent/conversations/${c.id}/export?format=md`;
          link.rel = 'noopener';
          document.body.appendChild(link);
          link.click();
          link.remove();
        },
      },
      'divider',
      { label: m.delete, tone: 'danger', onSelect: () => setDialog({ kind: 'delete', conversation: c }) },
    ];
    setMenu({ anchor: anchor.getBoundingClientRect(), entries, forId: c.id });
  }

  function modelMenu(anchor: HTMLElement): void {
    setMenu({
      anchor: anchor.getBoundingClientRect(),
      entries: [
        { heading: a.model },
        ...status.modelOptions.map((option) => ({
          label: option.label,
          description: option.description,
          checked: option.id === model,
          onSelect: () => void pickModel(option.id),
        })),
      ],
    });
  }

  function modeMenu(anchor: HTMLElement): void {
    setMenu({
      anchor: anchor.getBoundingClientRect(),
      entries: [
        { heading: a.modeHeading },
        ...AGENT_MODES.map((m) => ({
          label: a.modes[m].label,
          description: a.modes[m].hint,
          checked: m === mode,
          onSelect: () => pickMode(m),
        })),
      ],
    });
  }

  // ── derived ──────────────────────────────────────────────────────────
  const groups = useMemo(() => {
    const q = search.trim().toLocaleLowerCase(locale);
    const list = q ? conversations.filter((c) => c.title.toLocaleLowerCase(locale).includes(q)) : conversations;
    const map = new Map<Group, AgentConversationSummary[]>();
    for (const c of list) {
      const g = groupOf(c);
      map.set(g, [...(map.get(g) ?? []), c]);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)!] as const);
  }, [conversations, search, locale]);

  // What a later edit superseded is folded as an earlier version — the same rule the server reads by.
  const thread = useMemo(() => {
    const messages = current?.messages ?? [];
    const superseded = agentSupersededIds(messages);
    const parts: { earlier: boolean; messages: AgentMessageView[] }[] = [];
    for (const m of messages) {
      const earlier = superseded.has(m.id);
      const last = parts.at(-1);
      if (last && last.earlier === earlier) last.messages.push(m);
      else parts.push({ earlier, messages: [m] });
    }
    return parts;
  }, [current?.messages]);
  const standing = thread.filter((p) => !p.earlier).flatMap((p) => p.messages);
  const lastAsked = standing.findLast((m) => m.role === 'user') ?? null;
  const lastAnswerId = standing.findLast((m) => m.role === 'assistant' && m.content.trim() !== '')?.id ?? null;
  const empty = !current || (current.messages.length === 0 && !waiting);
  const pinnedCards = (current?.messages ?? [])
    .filter((m) => view.pinned.includes(m.id))
    .map((m) => ({ id: m.id, data: presentedOf(m) }))
    .filter((c): c is { id: string; data: NonNullable<ReturnType<typeof presentedOf>> } => c.data !== null);

  const hour = mounted ? new Date().getHours() : 12;
  const part = hour < 5 ? a.greeting.night : hour < 12 ? a.greeting.morning : hour < 18 ? a.greeting.afternoon : a.greeting.evening;
  const first = status.reader.name.trim().split(/\s+/)[0];
  const greeting = first ? a.greetingName(part, first) : part;

  const composer = (
    <Composer
      locale={locale}
      status={status}
      draft={draft}
      onDraft={setDraft}
      onSend={() => void send()}
      onAttach={(f) => void attachFile(f)}
      onPasteTable={(text) => void attachPaste(text)}
      pending={pending}
      onUnattach={(id) => setPending((l) => l.filter((x) => x.id !== id))}
      busy={waiting !== null}
      uploading={uploading}
      disabled={disabled}
      model={model}
      onPickModel={modelMenu}
      mode={mode}
      onPickMode={modeMenu}
      onStop={() => void stop()}
      stopping={stopping}
      autoFocus
    />
  );

  return (
    <div className="agent-app" data-rail={rail}>
      {/* ── the rail ── */}
      <aside className="agent-rail" aria-label={a.title}>
        <div className="agent-rail-head">
          <Mark size={30} />
          <span className="agent-rail-name">
            {a.name} <span>{a.nameAccent}</span>
          </span>
          <span className="agent-spacer" />
          <button
            type="button"
            className="agent-ghost"
            title={`${a.hideList} — Ctrl+\\`}
            aria-label={a.hideList}
            onClick={() => setRail('closed')}
          >
            <PanelLeftClose size={17} strokeWidth={1.6} />
          </button>
        </div>
        <button type="button" className="agent-rail-new" onClick={() => show(null)}>
          {a.newChat} <span className="agent-kbd">Ctrl K</span>
        </button>
        <div className="agent-rail-search">
          <input
            type="search"
            placeholder={a.search}
            aria-label={a.search}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <nav className="agent-threads">
          {groups.map(([group, items]) => (
            <div key={group} className="agent-group">
              <div className="agent-group-label">{a.groups[group]}</div>
              {items.map((c) => (
                <div
                  key={c.id}
                  className="agent-thread-row"
                  aria-current={current?.conversation.id === c.id ? 'true' : undefined}
                  data-menu={menu?.forId === c.id ? 'open' : undefined}
                >
                  <button type="button" className="agent-thread-open" onClick={() => void open(c.id)}>
                    <span className="agent-thread-title">{c.title}</span>
                    <span className="agent-thread-sub">
                      <When value={c.lastMessageAt} locale={locale} />
                    </span>
                  </button>
                  <button
                    type="button"
                    className="agent-thread-more"
                    aria-label={a.optionsFor(c.title)}
                    onClick={(e) => threadMenu(e.currentTarget, c)}
                  >
                    ···
                  </button>
                </div>
              ))}
            </div>
          ))}
          {hits.length > 0 && (
            <div className="agent-group">
              <div className="agent-group-label">{a.inMessages}</div>
              {hits.map((h) => (
                <div key={h.messageId} className="agent-thread-row">
                  <button
                    type="button"
                    className="agent-thread-open"
                    onClick={() => {
                      setFound(h.messageId);
                      void open(h.conversationId);
                    }}
                  >
                    <span className="agent-thread-title">{h.conversationTitle}</span>
                    <span className="agent-thread-sub agent-hit">
                      {h.role === 'assistant' ? a.agentSaid : ''}
                      <Highlight text={h.excerpt} words={search.trim()} />
                    </span>
                  </button>
                </div>
              ))}
            </div>
          )}
          {groups.length === 0 && hits.length === 0 && (
            <p className="agent-rail-empty">
              {search ? (search.trim().length < 2 ? a.noMatch : a.nothingFound) : a.railEmpty}
            </p>
          )}
        </nav>
        <div className="agent-rail-foot">
          <div
            className="agent-rail-usage"
            title={a.usageTitle(number.format(allowance.tokens.used), number.format(allowance.tokens.ceiling))}
          >
            <span>{a.today}</span>
            <span>
              {a.usage(
                Math.round(allowance.usedShare * 100),
                number.format(allowance.messagesLeft),
                allowance.messagesLeft === 1,
              )}
            </span>
          </div>
          <div className="agent-rail-track">
            <span style={{ width: `${allowance.usedShare * 100}%` }} />
          </div>
        </div>
      </aside>

      {/* ── the stage ── */}
      <section className="agent-stage">
        <header className="agent-top">
          {rail === 'closed' && (
            <button
              type="button"
              className="agent-ghost"
              title={a.showList}
              aria-label={a.showList}
              onClick={() => setRail('open')}
            >
              <PanelLeftOpen size={17} strokeWidth={1.6} />
            </button>
          )}
          <div className="agent-top-title">{current && <span>{current.conversation.title}</span>}</div>
          {!current && status.provider === 'development' && <span className="agent-badge">{a.standIn}</span>}
          <ViewMenu locale={locale} view={view} onChange={changeView} />
          {current && (
            <button
              type="button"
              className="agent-ghost"
              aria-label={a.optionsFor(current.conversation.title)}
              onClick={(e) => threadMenu(e.currentTarget, current.conversation)}
            >
              ···
            </button>
          )}
        </header>

        <div className="agent-scroll" aria-live="polite">
          <div className="agent-column" style={empty ? { height: '100%' } : undefined}>
            {empty ? (
              <div className="agent-hero">
                <div className="agent-hero-mark">
                  <Mark size={104} />
                </div>
                <h1 className="agent-greeting" suppressHydrationWarning>
                  {greeting}
                </h1>
                <p className="agent-greeting-sub">{disabled ? a.unavailableSub : a.greetingSub}</p>
                {!status.configured && (
                  <div className="agent-alert" style={{ marginBottom: 16 }}>
                    <strong>{a.notConfiguredTitle}</strong>
                    {a.notConfiguredBody}
                  </div>
                )}
                {alert && (
                  <div className="agent-alert" data-tone={alert.tone} style={{ marginBottom: 16 }}>
                    <strong>{alert.title}</strong>
                    {alert.body}
                  </div>
                )}
                {composer}
                <div className="agent-tasks">
                  {a.tasks.map((task) => (
                    <button
                      key={task.text}
                      type="button"
                      className="agent-task"
                      disabled={disabled}
                      onClick={() => setDraft(task.text)}
                    >
                      <span className="agent-task-logo">
                        <Mark size={26} />
                      </span>
                      <span>{task.text}</span>
                      <span className="agent-task-scale">{task.scale}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="agent-messages" data-density={view.density}>
                {pinnedCards.length > 0 && (
                  <div className="agent-pinned" aria-label={a.card.pinned}>
                    {pinnedCards.map(({ id, data }) => (
                      <DataCard key={id} locale={locale} id={id} data={data} view={view} onView={changeView} />
                    ))}
                  </div>
                )}
                {thread.map((part) => {
                  const render = (m: AgentMessageView) => (
                    <MessageWithMemory
                      key={m.id}
                      locale={locale}
                      boundary={m.id === current!.conversation.summarizedThrough}
                      memory={current!.memory}
                    >
                      <Message
                        locale={locale}
                        message={m}
                        view={view}
                        onView={changeView}
                        actions={current!.actions}
                        onAction={upsertAction}
                        {...(!part.earlier && waiting === null
                          ? {
                              onEdit: m.role === 'user' ? (text: string) => send(text, m.id) : undefined,
                              onAskAgain:
                                m.id === lastAnswerId && lastAsked
                                  ? () => void send(lastAsked.content, lastAsked.id)
                                  : undefined,
                            }
                          : {})}
                        onRate={part.earlier ? undefined : rate}
                      />
                    </MessageWithMemory>
                  );
                  return part.earlier ? (
                    <details key={part.messages[0]!.id} className="agent-earlier">
                      <summary>{a.message.earlier}</summary>
                      <div className="agent-earlier-body">{part.messages.map(render)}</div>
                    </details>
                  ) : (
                    part.messages.map(render)
                  );
                })}
                {current!.actions
                  .filter((x) => !current!.messages.some((m) => m.role === 'tool' && actionIdOf(m.content) === x.id))
                  .map((x) => (
                    <div key={x.id} className="agent-turn-agent">
                      <span />
                      <div className="agent-turn-body">
                        <ActionCard locale={locale} action={x} onChange={upsertAction} />
                      </div>
                    </div>
                  ))}
                {waiting && (
                  <>
                    {!echoed && (
                      <div className="agent-turn-user">
                        <MessageText text={waiting} />
                      </div>
                    )}
                    <div className="agent-turn-agent" role="status">
                      <span className="agent-avatar">
                        <Mark size={34} />
                      </span>
                      <div className="agent-turn-body">
                        {live.length > 0 && <StepsCard locale={locale} reasoning={null} steps={live} live defaultOpen />}
                        {written && written.text.trim() !== '' ? (
                          <div className="agent-written" aria-live="off">
                            <MessageText text={written.text} />
                          </div>
                        ) : (
                          <div className="agent-thinking">
                            <span className="agent-dots" aria-hidden>
                              <i />
                              <i />
                              <i />
                            </span>
                            <span key={thinking} className="agent-thinking-text">
                              {stopping ? a.stopping : live.length > 0 ? live[live.length - 1]!.summary : a.thinking[thinking]}…
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}
                {alert && (
                  <div className="agent-alert" data-tone={alert.tone}>
                    <strong>{alert.title}</strong>
                    {alert.body}
                  </div>
                )}
                <div ref={endRef} />
              </div>
            )}
          </div>
        </div>

        {!empty && (
          <div className="agent-dock">
            <div className="agent-column">
              {composer}
              <p className="agent-dock-note">{a.dockNote[mode]}</p>
            </div>
          </div>
        )}
      </section>

      {menu && <Menu anchor={menu.anchor} entries={menu.entries} onClose={() => setMenu(null)} />}

      {dialog?.kind === 'rename' && (
        <RenameDialog
          locale={locale}
          conversation={dialog.conversation}
          onClose={() => setDialog(null)}
          onSave={async (title) => {
            if (await patch(dialog.conversation.id, { title })) {
              setDialog(null);
              notify(a.toast.renamed);
            }
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteDialog
          locale={locale}
          conversation={dialog.conversation}
          onClose={() => setDialog(null)}
          onDelete={() => remove(dialog.conversation)}
        />
      )}
      {dialog?.kind === 'details' && current && (
        <DetailsDialog
          locale={locale}
          view={current}
          modelLabel={status.modelOptions.find((m) => m.id === current.conversation.model)?.label ?? null}
          onClose={() => setDialog(null)}
        />
      )}
      {toast && (
        <div key={toast.n} className="agent-toast" role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}

function Message({
  locale,
  message,
  onEdit,
  onAskAgain,
  onRate,
  view,
  onView,
  actions,
  onAction,
}: {
  locale: Locale;
  message: AgentMessageView;
  /** A person's message that may be edited and sent again. */
  onEdit?: ((text: string) => Promise<void>) | undefined;
  /** The last answer, which may be asked for again. */
  onAskAgain?: (() => void) | undefined;
  /** An answer the reader may rate. */
  onRate?: ((messageId: string, rating: 1 | -1, note: string) => Promise<boolean>) | undefined;
  view: AgentView;
  onView: (change: Partial<AgentView>) => void;
  /** The conversation's actions, for a tool answer that names one. */
  actions: AgentActionView[];
  onAction: (action: AgentActionView) => void;
}) {
  const a = getDictionary(locale).app.agent;
  const [editing, setEditing] = useState<string | null>(null);
  if (message.role === 'user') {
    if (editing !== null && onEdit) {
      const submit = () => {
        const text = editing;
        setEditing(null);
        void onEdit(text);
      };
      return (
        <div className="agent-turn-user" data-editing>
          <textarea
            className="agent-edit"
            aria-label={a.message.editAria}
            value={editing}
            rows={Math.min(8, Math.max(2, editing.split('\n').length))}
            autoFocus
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(null);
              if (e.key === 'Enter' && !e.shiftKey && editing.trim()) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="agent-message-actions">
            <button type="button" className="agent-ghost" onClick={() => setEditing(null)}>
              {a.message.cancel}
            </button>
            <button
              type="button"
              className="agent-ghost"
              data-variant="outline"
              disabled={!editing.trim() || editing.trim() === message.content.trim()}
              onClick={submit}
            >
              {a.message.send}
            </button>
          </div>
        </div>
      );
    }
    const number = new Intl.NumberFormat(locale);
    return (
      <div className="agent-turn-user" id={`m-${message.id}`}>
        <MessageText text={message.content} />
        {onEdit && message.attachments.length === 0 && (
          <div className="agent-message-actions" data-quiet>
            <button type="button" className="agent-link" onClick={() => setEditing(message.content)}>
              {a.message.edit}
            </button>
          </div>
        )}
        {message.attachments.length > 0 && (
          <div className="agent-chips">
            {message.attachments.map((attachment) => (
              <span key={attachment.id} className="agent-chip">
                {attachment.name} ·{' '}
                {attachment.kind === 'document' ? a.message.document : a.message.rows(number.format(attachment.rows))}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (message.role === 'tool') {
    const actionId = actionIdOf(message.content);
    const action = actionId ? actions.find((x) => x.id === actionId) : undefined;
    if (action) {
      return (
        <div className="agent-turn-agent">
          <span />
          <div className="agent-turn-body">
            <ActionCard locale={locale} action={action} onChange={onAction} />
          </div>
        </div>
      );
    }
    const data = presentedOf(message);
    if (data && !view.pinned.includes(message.id)) {
      return (
        <div className="agent-turn-agent">
          <span />
          <div className="agent-turn-body">
            <DataCard locale={locale} id={message.id} data={data} view={view} onView={onView} />
          </div>
        </div>
      );
    }
    return null;
  }
  const steps = [...new Set(message.toolCalls.map((c) => c.summary))];
  if (message.content.trim() === '' && steps.length === 0) return null;
  return (
    <div className="agent-turn-agent" id={`m-${message.id}`}>
      <span className="agent-avatar">
        <Mark size={34} />
      </span>
      <div className="agent-turn-body">
        <StepsCard
          locale={locale}
          reasoning={message.reasoning}
          steps={steps.map((summary) => ({ summary, done: true }))}
          defaultOpen={view.steps === 'open'}
        />
        {message.content.trim() !== '' && <MessageText text={message.content} />}
        {message.content.trim() !== '' && (
          <AnswerActions locale={locale} message={message} onRate={onRate} onAskAgain={onAskAgain} />
        )}
      </div>
    </div>
  );
}

/** Under an answer: ask for it again, and say whether it was good. Words, not icons. */
function AnswerActions({
  locale,
  message,
  onRate,
  onAskAgain,
}: {
  locale: Locale;
  message: AgentMessageView;
  onRate?: ((messageId: string, rating: 1 | -1, note: string) => Promise<boolean>) | undefined;
  onAskAgain?: (() => void) | undefined;
}) {
  const m = getDictionary(locale).app.agent.message;
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  if (!onRate && !onAskAgain) return null;
  const give = async (rating: 1 | -1, withNote = '') => {
    if (!onRate) return;
    setBusy(true);
    const ok = await onRate(message.id, rating, withNote.trim());
    setBusy(false);
    if (ok) {
      setNoting(false);
      setNote('');
    }
  };
  return (
    <>
      <div className="agent-message-actions" data-quiet>
        {onAskAgain && (
          <button type="button" className="agent-link" onClick={onAskAgain}>
            {m.askAgain}
          </button>
        )}
        {onRate && (
          <>
            <button
              type="button"
              className="agent-link"
              aria-pressed={message.rating === 1}
              data-on={message.rating === 1 || undefined}
              disabled={busy}
              onClick={() => void give(1)}
            >
              {m.helpful}
            </button>
            <button
              type="button"
              className="agent-link"
              aria-pressed={message.rating === -1}
              data-on={message.rating === -1 || undefined}
              disabled={busy}
              onClick={() => setNoting((n) => !n)}
            >
              {m.notHelpful}
            </button>
          </>
        )}
      </div>
      {noting && (
        <form
          className="agent-feedback"
          onSubmit={(e) => {
            e.preventDefault();
            void give(-1, note);
          }}
        >
          <input
            className="control"
            maxLength={1000}
            value={note}
            autoFocus
            placeholder={m.notePlaceholder}
            aria-label={m.noteAria}
            onChange={(e) => setNote(e.target.value)}
          />
          <button type="submit" className="agent-ghost" data-variant="outline" disabled={busy}>
            {m.send}
          </button>
        </form>
      )}
    </>
  );
}

/** The words searched for, marked where they stand in a found line. */
function Highlight({ text, words }: { text: string; words: string }) {
  const at = words ? text.toLowerCase().indexOf(words.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {at > 40 ? '…' : ''}
      {text.slice(at > 40 ? at - 40 : 0, at)}
      <mark>{text.slice(at, at + words.length)}</mark>
      {text.slice(at + words.length)}
    </>
  );
}

/**
 * A message, and — after the last one the agent's summary covers — a divider
 * saying so, with the summary itself to read: what the agent now remembers in
 * place of the messages above.
 */
function MessageWithMemory({
  locale,
  boundary,
  memory,
  children,
}: {
  locale: Locale;
  boundary: boolean;
  memory: string | null;
  children: ReactNode;
}) {
  if (!boundary) return <>{children}</>;
  return (
    <>
      {children}
      <details className="agent-memory">
        <summary>{getDictionary(locale).app.agent.message.memory}</summary>
        {memory && (
          <div className="agent-memory-body">
            <MessageText text={memory} />
          </div>
        )}
      </details>
    </>
  );
}
