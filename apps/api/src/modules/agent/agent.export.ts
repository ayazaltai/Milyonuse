import { Injectable } from '@nestjs/common';
import { type AgentMessageView, type Principal, agentSupersededIds } from '@milyonuse/contracts';
import { AuditService } from '../tenancy/audit.service.js';
import { AgentService } from './agent.service.js';
import { AgentStore } from './agent.store.js';

/**
 * A conversation taken out as a Markdown document (ported from App-Milyonus
 * `modules/agent/agent.export.ts`): what was said, earlier versions an edit
 * replaced marked as such, and the cards the agent laid out as tables. Only
 * the person whose conversation it is may export it, and every export is in
 * the audit log.
 */

interface Table {
  columns: string[];
  rows: string[][];
  /** Said under the table — what it left out. */
  note?: string;
}

type Block =
  | { type: 'said'; who: string; at: string; text: string; earlier: boolean }
  | { type: 'card'; title: string; subtitle?: string; table: Table };

interface Outline {
  title: string;
  facts: string[];
  blocks: Block[];
}

export interface ConversationExport {
  filename: string;
  contentType: string;
  body: Buffer;
}

/** Rows a table in the document holds; the rest is counted, not printed. */
const TABLE_ROWS = 200;

const when = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

@Injectable()
export class AgentExportService {
  constructor(
    private readonly agent: AgentService,
    private readonly store: AgentStore,
    private readonly audit: AuditService,
  ) {}

  async export(principal: Principal, conversationId: string): Promise<ConversationExport> {
    const view = await this.agent.get(principal, conversationId);
    const reader = await this.store.run(principal, async (client) => {
      const { rows } = await client.query<{ name: string }>(`SELECT btrim(name) AS name FROM users WHERE id = $1`, [
        principal.userId,
      ]);
      await this.audit.record(client, {
        organizationId: principal.organizationId,
        actorMemberId: principal.memberId,
        action: 'agent.conversation_exported',
        resourceType: 'agent_conversation',
        resourceId: conversationId,
        after: { format: 'md', messages: view.messages.length },
      });
      return rows[0]?.name || 'You';
    });

    const exportedAt = new Date().toISOString();
    const outline = outlineOf(view.conversation.title, view.messages, {
      person: reader,
      created: view.conversation.createdAt,
      last: view.conversation.lastMessageAt,
      exportedAt,
    });
    const base = `${
      view.conversation.title
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60) || 'conversation'
    }-${exportedAt.slice(0, 10)}`;
    return {
      filename: `${base}.md`,
      contentType: 'text/markdown; charset=utf-8',
      body: Buffer.from(markdownOf(outline), 'utf8'),
    };
  }
}

// ─────────────────────────────────────────────────────────────── the outline

function outlineOf(
  title: string,
  messages: AgentMessageView[],
  head: { person: string; created: string; last: string; exportedAt: string },
): Outline {
  const superseded = agentSupersededIds(messages);
  const blocks: Block[] = [];
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'assistant') {
      if (m.content.trim() === '') continue;
      blocks.push({
        type: 'said',
        who: m.role === 'user' ? head.person : 'Milyonuse',
        at: m.createdAt,
        text: m.content.trim(),
        earlier: superseded.has(m.id),
      });
      continue;
    }
    if (m.toolName === 'present') {
      const card = presented(m.content);
      if (card) blocks.push(card);
    }
  }
  return {
    title,
    facts: [
      `Conversation of ${head.person}, started ${when(head.created)}, last message ${when(head.last)}`,
      `Exported at ${when(head.exportedAt)}`,
    ],
    blocks,
  };
}

const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v));

function presented(content: string): Block | null {
  try {
    const data = JSON.parse(content) as {
      presented?: boolean;
      title?: string;
      subtitle?: string;
      columns?: string[];
      rows?: unknown[][];
      items?: { label: string; value: unknown; hint?: string }[];
      total?: number;
    };
    if (!data.presented) return null;
    const table: Table = data.columns
      ? { columns: data.columns, rows: (data.rows ?? []).map((r) => r.map(cell)) }
      : { columns: ['', ''], rows: (data.items ?? []).map((i) => [i.label, cell(i.value)]) };
    const total = data.total ?? table.rows.length;
    if (table.rows.length > TABLE_ROWS || total > table.rows.length) {
      table.note = `${Math.min(table.rows.length, TABLE_ROWS)} of ${total} lines shown.`;
      table.rows = table.rows.slice(0, TABLE_ROWS);
    }
    return { type: 'card', title: data.title ?? 'Data', ...(data.subtitle ? { subtitle: data.subtitle } : {}), table };
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────── Markdown

export function markdownOf(outline: Outline): string {
  const escape = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const table = (t: Table) => {
    const width = t.columns.length;
    const lines = [
      `| ${t.columns.map(escape).join(' | ')} |`,
      `|${' --- |'.repeat(width)}`,
      ...t.rows.map((r) => `| ${Array.from({ length: width }, (_, i) => escape(r[i] ?? '')).join(' | ')} |`),
    ];
    if (t.note) lines.push('', `_${t.note}_`);
    return lines.join('\n');
  };
  const out = [`# ${outline.title}`, '', ...outline.facts.map((f) => `- ${f}`), ''];
  for (const b of outline.blocks) {
    if (b.type === 'said') {
      out.push(`### ${b.who} · ${when(b.at)}${b.earlier ? ' · earlier version, replaced by an edit' : ''}`, '');
      out.push(
        b.earlier
          ? b.text
              .split('\n')
              .map((l) => `> ${l}`)
              .join('\n')
          : b.text,
        '',
      );
    } else {
      out.push(`#### ${b.title}`, '');
      if (b.subtitle) out.push(b.subtitle, '');
      out.push(table(b.table), '');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}
