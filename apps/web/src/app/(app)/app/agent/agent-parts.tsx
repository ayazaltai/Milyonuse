'use client';

import Image from 'next/image';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  AgentAttachmentView,
  AgentConversationSummary,
  AgentConversationView,
  AgentMode,
  AgentStatus,
  Locale,
} from '@milyonuse/contracts';
import { getDictionary } from '@/i18n';

/**
 * The pieces of the agent's workspace (ported from App-Milyonus
 * `(dashboard)/agent/agent-parts.tsx`): the composer, a menu, the dialogs.
 * No icons in the conversation itself — the mark, and words.
 */

export function Mark({ size }: { size: number }) {
  // The file has wide transparent margins around the star; it is drawn larger
  // than its box and centred, so `size` is the star itself, not the canvas.
  const drawn = Math.round(size * 1.8);
  return (
    <span className="agent-mark" style={{ width: size, height: size }}>
      <Image src="/brand/milyonus-mark.png" alt="" width={drawn} height={drawn} style={{ width: drawn, height: drawn }} />
    </span>
  );
}

/** "3 Oct" or "14:05" — when a conversation last moved, by the reader's clock once in the browser. */
export function When({ value, locale }: { value: string; locale: Locale }) {
  const [text, setText] = useState('');
  useEffect(() => {
    const at = new Date(value);
    const today = new Date();
    const sameDay = at.toDateString() === today.toDateString();
    setText(
      new Intl.DateTimeFormat(
        locale,
        sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' },
      ).format(at),
    );
  }, [value, locale]);
  return <span suppressHydrationWarning>{text}</span>;
}

// ─────────────────────────────────────────────────────────────── composer

export function Composer({
  locale,
  status,
  draft,
  onDraft,
  onSend,
  onAttach,
  onPasteTable,
  pending,
  onUnattach,
  busy,
  uploading,
  disabled,
  model,
  onPickModel,
  mode,
  onPickMode,
  onStop,
  stopping,
  autoFocus,
}: {
  locale: Locale;
  status: AgentStatus;
  draft: string;
  onDraft: (value: string) => void;
  onSend: () => void;
  onAttach: (file: File) => void;
  onPasteTable: (text: string) => void;
  pending: AgentAttachmentView[];
  onUnattach: (id: string) => void;
  busy: boolean;
  uploading: boolean;
  disabled: boolean;
  model: string;
  onPickModel: (anchor: HTMLElement) => void;
  mode: AgentMode;
  onPickMode: (anchor: HTMLElement) => void;
  /** While a turn runs, the send button becomes Stop. */
  onStop?: () => void;
  stopping?: boolean;
  autoFocus?: boolean;
}) {
  const a = getDictionary(locale).app.agent;
  const number = new Intl.NumberFormat(locale);
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);

  // The surface grows with what is written, to a point, then scrolls.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [draft]);

  useEffect(() => {
    if (autoFocus && !disabled) area.current?.focus();
  }, [autoFocus, disabled]);

  const state = !status.configured ? 'off' : status.provider === 'development' ? 'standIn' : 'on';
  const canSend = !disabled && !busy && draft.trim() !== '';
  // The model in plain words; its identifier only on hover.
  const option = status.modelOptions.find((m) => m.id === model);
  const modelLabel = option?.label ?? (model.includes('/') ? model.split('/').slice(1).join('/') : model);

  return (
    <form
      className="agent-composer"
      data-disabled={disabled ? 'true' : undefined}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) onSend();
      }}
    >
      <span className="agent-composer-dot" data-state={state === 'standIn' ? 'standin' : state} title={a.dot[state]} />
      {pending.length > 0 && (
        <div className="agent-tables">
          {pending.map((p) => (
            <span key={p.id} className="agent-table-chip">
              {p.name}
              <small>
                {p.kind === 'document'
                  ? a.documentMeta(p.pages, number.format(p.characters ?? 0))
                  : a.tableMeta(number.format(p.rowCount), p.columnCount)}
              </small>
              <button type="button" onClick={() => onUnattach(p.id)} aria-label={a.removeAttachment(p.name)}>
                {a.remove}
              </button>
            </span>
          ))}
        </div>
      )}
      {draft === '' && (
        <div className="agent-placeholder" aria-hidden>
          {disabled ? a.placeholderOff : a.placeholder}
        </div>
      )}
      <textarea
        ref={area}
        rows={2}
        aria-label={a.messageAria}
        maxLength={status.limits.messageChars}
        value={draft}
        disabled={disabled}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSend) onSend();
          }
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text/plain');
          if (looksLikeTable(text)) {
            e.preventDefault();
            onPasteTable(text);
          }
        }}
      />
      <div className="agent-composer-row">
        <button
          type="button"
          className="agent-pill"
          disabled={disabled || status.modelOptions.length < 2}
          title={option ? `${option.description} — ${option.id}` : model}
          onClick={(e) => onPickModel(e.currentTarget)}
        >
          <span className="agent-pill-label">{a.model}</span>
          <span className="agent-pill-value">{modelLabel}</span>
        </button>
        <button
          type="button"
          className="agent-pill"
          data-mode={mode}
          disabled={disabled}
          title={a.modes[mode].hint}
          onClick={(e) => onPickMode(e.currentTarget)}
        >
          <span className="agent-pill-label">{a.mode}</span>
          <span className="agent-pill-value">{a.modes[mode].label}</span>
        </button>
        <span className="agent-spacer" />
        {draft.length > status.limits.messageChars * 0.8 && (
          <span className="agent-count">
            {number.format(draft.length)} / {number.format(status.limits.messageChars)}
          </span>
        )}
        <input
          ref={file}
          type="file"
          hidden
          accept=".csv,.tsv,.txt,.md,.xlsx,.pdf,.docx,text/csv,text/plain,text/markdown,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) onAttach(f);
          }}
        />
        <button
          type="button"
          className="agent-square"
          title={a.attachTitle(number.format(status.limits.attachmentRows))}
          aria-label={a.attachAria}
          disabled={disabled || uploading}
          onClick={() => file.current?.click()}
        >
          {uploading ? '…' : '+'}
        </button>
        {busy && onStop ? (
          <button
            type="button"
            className="agent-square"
            data-variant="stop"
            aria-label={a.stopAria}
            title={a.stopTitle}
            disabled={stopping}
            onClick={onStop}
          >
            ■
          </button>
        ) : (
          <button
            type="submit"
            className="agent-square"
            data-variant="send"
            aria-label={a.sendAria}
            title={a.sendTitle}
            disabled={!canSend}
          >
            ↑
          </button>
        )}
      </div>
    </form>
  );
}

/** A paste from a spreadsheet: several lines, separated by tabs. */
export function looksLikeTable(text: string): boolean {
  const lines = text.trim().split(/\r?\n/);
  return lines.length >= 3 && lines.filter((l) => l.includes('\t')).length >= Math.min(lines.length, 3);
}

// ─────────────────────────────────────────────────────────────────── menu

export interface MenuItem {
  label: string;
  /** A sentence under the label, for a choice that needs saying what it does. */
  description?: string;
  tone?: 'danger';
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}
export type MenuEntry = MenuItem | 'divider' | { heading: string };

/** A small menu beside what opened it; Escape or a click elsewhere closes it. */
export function Menu({ anchor, entries, onClose }: { anchor: DOMRect; entries: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const described = entries.some((e) => typeof e === 'object' && 'label' in e && !!e.description);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: anchor.bottom + 6, left: anchor.left });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Its laid-out size, not the rectangle mid-animation, which is scaled down.
    const height = el.offsetHeight;
    const width = el.offsetWidth;
    const top = anchor.bottom + 6 + height > window.innerHeight - 8 ? Math.max(8, anchor.top - 6 - height) : anchor.bottom + 6;
    const left = Math.min(anchor.left, window.innerWidth - width - 8);
    setPos({ top, left });
    el.querySelector<HTMLButtonElement>('button')?.focus();
  }, [anchor]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const buttons = [...(ref.current?.querySelectorAll('button') ?? [])];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="agent-menu"
      role="menu"
      data-described={described || undefined}
      style={{ top: pos.top, left: pos.left }}
    >
      {entries.map((entry, i) =>
        entry === 'divider' ? (
          <hr key={i} />
        ) : 'heading' in entry ? (
          <div key={i} className="agent-menu-label">
            {entry.heading}
          </div>
        ) : (
          <button
            key={i}
            type="button"
            role={entry.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={entry.checked}
            data-tone={entry.tone}
            disabled={entry.disabled}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
          >
            {entry.description ? (
              <span className="agent-menu-text">
                <span>{entry.label}</span>
                <span className="agent-menu-desc">{entry.description}</span>
              </span>
            ) : (
              <span>{entry.label}</span>
            )}
          </button>
        ),
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────── dialogs

export function Dialog({
  title,
  accent,
  lead,
  children,
  actions,
  onClose,
}: {
  title: string;
  accent?: string;
  lead?: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', key);
    ref.current?.querySelector<HTMLElement>('input, button[data-autofocus]')?.focus();
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div
      className="agent-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} className="agent-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>
          {title} {accent && <em>{accent}</em>}
        </h2>
        {lead && <p className="agent-dialog-lead">{lead}</p>}
        {children && <div className="agent-dialog-body">{children}</div>}
        <div className="agent-dialog-actions">{actions}</div>
      </div>
    </div>
  );
}

export function RenameDialog({
  locale,
  conversation,
  onSave,
  onClose,
}: {
  locale: Locale;
  conversation: AgentConversationSummary;
  onSave: (title: string) => Promise<void>;
  onClose: () => void;
}) {
  const d = getDictionary(locale).app.agent.dialog;
  const [title, setTitle] = useState(conversation.title);
  const [busy, setBusy] = useState(false);
  const ok = title.trim().length > 0 && title.trim() !== conversation.title;
  async function save() {
    if (!ok) return;
    setBusy(true);
    await onSave(title.trim());
    setBusy(false);
  }
  return (
    <Dialog
      title={d.renameTitle}
      accent={d.renameAccent}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="agent-ghost" onClick={onClose}>
            {d.cancel}
          </button>
          <button
            type="button"
            className="agent-ghost"
            data-variant="outline"
            disabled={!ok || busy}
            onClick={() => void save()}
          >
            {busy ? d.saving : d.save}
          </button>
        </>
      }
    >
      <input
        className="control"
        value={title}
        maxLength={120}
        aria-label={d.titleAria}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
        }}
      />
    </Dialog>
  );
}

export function DeleteDialog({
  locale,
  conversation,
  onDelete,
  onClose,
}: {
  locale: Locale;
  conversation: AgentConversationSummary;
  onDelete: () => Promise<void>;
  onClose: () => void;
}) {
  const d = getDictionary(locale).app.agent.dialog;
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={d.deleteTitle}
      accent={`“${conversation.title}”?`}
      lead={d.deleteLead}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="agent-ghost" data-autofocus onClick={onClose}>
            {d.keep}
          </button>
          <button
            type="button"
            className="agent-ghost"
            data-variant="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onDelete();
            }}
          >
            {busy ? d.deleting : d.deleteTitle}
          </button>
        </>
      }
    />
  );
}

export function DetailsDialog({
  locale,
  view,
  modelLabel,
  onClose,
}: {
  locale: Locale;
  view: AgentConversationView;
  /** The model in plain words, when the deployment knows it. */
  modelLabel: string | null;
  onClose: () => void;
}) {
  const d = getDictionary(locale).app.agent.dialog;
  const c = view.conversation;
  const date = (v: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v));
  const number = new Intl.NumberFormat(locale);
  return (
    <Dialog
      title={d.detailsTitle}
      accent={c.title}
      onClose={onClose}
      actions={
        <button type="button" className="agent-ghost" data-autofocus onClick={onClose}>
          {d.close}
        </button>
      }
    >
      <dl className="agent-facts">
        <dt>{d.model}</dt>
        <dd>{modelLabel ? `${modelLabel} · ${c.model}` : c.model}</dd>
        <dt>{d.started}</dt>
        <dd>{date(c.createdAt)}</dd>
        <dt>{d.lastActivity}</dt>
        <dd>{date(c.lastMessageAt)}</dd>
        <dt>{d.messages}</dt>
        <dd>{number.format(view.messages.filter((m) => m.role !== 'tool').length)}</dd>
        <dt>{d.attachments}</dt>
        <dd>{number.format(view.attachments.length)}</dd>
        <dt>{d.summarised}</dt>
        <dd>{c.summarizedAt ? date(c.summarizedAt) : d.notYet}</dd>
      </dl>
    </Dialog>
  );
}
