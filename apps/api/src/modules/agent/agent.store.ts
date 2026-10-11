import { Injectable } from '@nestjs/common';
import type {
  AgentAttachmentView,
  AgentConversationSummary,
  AgentMessageView,
  Principal,
} from '@milyonuse/contracts';
import type pg from 'pg';
import { AppError } from '../../common/app-error.js';
import { TenantScope } from '../tenancy/tenant-scope.service.js';
import type { AgentToolCall } from './agent-model.port.js';
import { forPage, sourcePrefix } from './answers.js';

/**
 * The agent's records (0006), read and written in the person's own scope, and
 * turned into what the page shows (ported from App-Milyonus
 * `modules/agent/agent.store.ts`).
 *
 * Every scope names the member as well as the organization, and the row-level
 * policies do too: a conversation is one person's, so another member's — of
 * any role — is "not found", never "not yours", even to a query that forgets
 * to filter by person.
 */

export interface ConversationRow {
  id: string;
  member_id: string;
  title: string;
  model: string;
  last_message_at: Date;
  created_at: Date;
  pinned_at: Date | null;
  /** The last message the agent's summary covers, and when it was written. */
  summary_through_id: string | null;
  summarized_at: Date | null;
}

export interface MessageRow {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls: AgentToolCall[] | null;
  tool_call_id: string | null;
  tool_name: string | null;
  attachments: { id: string; name: string; rows: number; kind?: 'document' }[] | null;
  model: string | null;
  reasoning: string | null;
  revises: string | null;
  created_at: Date;
}

export interface AttachmentRow {
  id: string;
  name: string;
  rows: string[][];
  row_count: number;
  column_count: number;
  expires_at: Date;
  kind: 'table' | 'document';
  pages: number | null;
  text_length: number | null;
}

export interface NewMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: AgentToolCall[] | undefined;
  toolCallId?: string | undefined;
  toolName?: string | undefined;
  attachments?: { id: string; name: string; rows: number; kind?: 'document' }[] | undefined;
  model?: string | undefined;
  promptVersion?: string | undefined;
  tokensIn?: number | undefined;
  tokensCached?: number | undefined;
  tokensOut?: number | undefined;
  costUsd?: number | null | undefined;
  reasoning?: string | undefined;
  revises?: string | undefined;
}

const CONVERSATION = `c.id, c.member_id, c.title, c.model, c.last_message_at, c.created_at, c.pinned_at,
  c.summary_through_id, c.summarized_at`;
const MESSAGE = `id, role::text AS role, content, tool_calls, tool_call_id, tool_name, attachments, model, reasoning,
                 revises, created_at`;

@Injectable()
export class AgentStore {
  constructor(private readonly scope: TenantScope) {}

  /** A transaction in the person's own scope: their organization, and them in it. */
  run<T>(principal: Principal, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.scope.run({ organizationId: principal.organizationId, memberId: principal.memberId }, fn);
  }

  // ──────────────────────────────────────────────────────────── conversations

  async conversation(client: pg.PoolClient, id: string): Promise<ConversationRow> {
    const { rows } = await client.query<ConversationRow>(
      `SELECT ${CONVERSATION} FROM agent_conversations c WHERE c.id = $1`,
      [id],
    );
    if (!rows[0]) throw AppError.notFound('Conversation');
    return rows[0];
  }

  /** The person's conversations — pinned first, then the latest. */
  async conversations(client: pg.PoolClient): Promise<ConversationRow[]> {
    const { rows } = await client.query<ConversationRow>(
      `SELECT ${CONVERSATION} FROM agent_conversations c
        ORDER BY c.pinned_at DESC NULLS LAST, c.last_message_at DESC, c.id DESC
        LIMIT 200`,
    );
    return rows;
  }

  async createConversation(
    client: pg.PoolClient,
    principal: Principal,
    input: { title: string; model: string },
  ): Promise<ConversationRow> {
    const { rows } = await client.query<ConversationRow>(
      `INSERT INTO agent_conversations AS c (organization_id, member_id, title, model)
       VALUES ($1, $2, $3, $4) RETURNING ${CONVERSATION}`,
      [principal.organizationId, principal.memberId, input.title, input.model],
    );
    return rows[0]!;
  }

  async updateConversation(
    client: pg.PoolClient,
    id: string,
    change: { title?: string | undefined; model?: string | undefined; pinned?: boolean | undefined },
  ): Promise<ConversationRow> {
    const { rows } = await client.query<ConversationRow>(
      `UPDATE agent_conversations AS c
          SET title = COALESCE($2, c.title),
              model = COALESCE($3, c.model),
              pinned_at = CASE WHEN $4::boolean IS NULL THEN c.pinned_at
                               WHEN $4 THEN COALESCE(c.pinned_at, now()) ELSE NULL END
        WHERE c.id = $1
        RETURNING ${CONVERSATION}`,
      [id, change.title ?? null, change.model ?? null, change.pinned ?? null],
    );
    if (!rows[0]) throw AppError.notFound('Conversation');
    return rows[0];
  }

  /** Deletes a conversation with everything in it; false when there was none. */
  async deleteConversation(client: pg.PoolClient, id: string): Promise<boolean> {
    const { rowCount } = await client.query(`DELETE FROM agent_conversations WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Words inside the person's conversations: what they and the agent said,
   * never a tool's answer. A trigram index (0006) serves the ILIKE; the
   * excerpt is cut around the first match.
   */
  async search(
    client: pg.PoolClient,
    q: string,
  ): Promise<
    {
      conversation_id: string;
      title: string;
      message_id: string;
      role: 'user' | 'assistant';
      excerpt: string;
      created_at: Date;
    }[]
  > {
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const { rows } = await client.query(
      `SELECT c.id AS conversation_id, c.title, m.id AS message_id, m.role::text AS role, m.created_at,
              substr(m.content, greatest(1, strpos(lower(m.content), lower($1)) - 60), 220) AS excerpt
         FROM agent_messages m JOIN agent_conversations c ON c.id = m.conversation_id
        WHERE m.role IN ('user', 'assistant') AND m.content ILIKE $2
        ORDER BY m.created_at DESC
        LIMIT 30`,
      [q, pattern],
    );
    return rows;
  }

  /** Asks a running turn of this conversation to stop, by the database's clock. */
  async requestStop(client: pg.PoolClient, conversationId: string): Promise<void> {
    await client.query(`UPDATE agent_conversations SET stop_requested_at = clock_timestamp() WHERE id = $1`, [
      conversationId,
    ]);
  }

  /** Whether a stop was asked for after a turn began. */
  async stopRequested(client: pg.PoolClient, conversationId: string, since: Date): Promise<boolean> {
    const { rows } = await client.query<{ asked: boolean }>(
      `SELECT COALESCE(stop_requested_at > $2, false) AS asked FROM agent_conversations WHERE id = $1`,
      [conversationId, since],
    );
    return rows[0]?.asked ?? false;
  }

  // ───────────────────────────────────────────────────────────────── messages

  async messages(client: pg.PoolClient, conversationId: string, limit = 500): Promise<MessageRow[]> {
    const { rows } = await client.query<MessageRow>(
      `SELECT * FROM (
         SELECT ${MESSAGE} FROM agent_messages WHERE conversation_id = $1
          ORDER BY created_at DESC, id DESC LIMIT $2
       ) recent ORDER BY created_at, id`,
      [conversationId, limit],
    );
    return rows;
  }

  /**
   * The messages the agent's summary does not cover yet — the newest `limit`
   * of them, oldest first. All of them before any summary.
   */
  async messagesAfterSummary(client: pg.PoolClient, conversationId: string, limit: number): Promise<MessageRow[]> {
    const { rows } = await client.query<MessageRow>(
      `SELECT * FROM (
         SELECT ${MESSAGE} FROM agent_messages m
          WHERE m.conversation_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM agent_conversations c
               WHERE c.id = $1 AND c.summary_through_at IS NOT NULL
                 AND (m.created_at, m.id) <= (c.summary_through_at, c.summary_through_id))
          ORDER BY m.created_at DESC, m.id DESC LIMIT $2
       ) recent ORDER BY created_at, id`,
      [conversationId, limit],
    );
    return rows;
  }

  /** The agent's summary of the conversation so far, when it has written one. */
  async summary(client: pg.PoolClient, conversationId: string): Promise<string | null> {
    const { rows } = await client.query<{ summary: string | null }>(
      `SELECT summary FROM agent_conversations WHERE id = $1`,
      [conversationId],
    );
    return rows[0]?.summary ?? null;
  }

  /**
   * Writes the summary through one of the conversation's messages. The
   * database keeps the boundary on its own messages and moving forward only
   * (app.guard_agent_summary, 0006).
   */
  async setSummary(client: pg.PoolClient, conversationId: string, summary: string, throughId: string): Promise<void> {
    await client.query(
      // The boundary's id and time read from the message itself — $3 named once, so
      // Postgres deduces one type for it, and the time keeps its microseconds.
      `WITH boundary AS (
         SELECT id, created_at FROM agent_messages WHERE id = $3 AND conversation_id = $1
       )
       UPDATE agent_conversations
          SET summary = $2,
              summary_through_id = (SELECT id FROM boundary),
              summary_through_at = (SELECT created_at FROM boundary),
              summarized_at = now()
        WHERE id = $1`,
      [conversationId, summary, throughId],
    );
  }

  async addMessage(
    client: pg.PoolClient,
    principal: Principal,
    conversationId: string,
    message: NewMessage,
  ): Promise<MessageRow> {
    const { rows } = await client.query<MessageRow>(
      `INSERT INTO agent_messages (organization_id, conversation_id, role, content, tool_calls, tool_call_id,
                                   tool_name, attachments, model, prompt_version, tokens_in, tokens_cached,
                                   tokens_out, cost_usd, reasoning, revises)
       VALUES ($1, $2, $3::agent_message_role, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING ${MESSAGE}`,
      [
        principal.organizationId,
        conversationId,
        message.role,
        message.content,
        message.toolCalls && message.toolCalls.length > 0 ? JSON.stringify(message.toolCalls) : null,
        message.toolCallId ?? null,
        message.toolName ?? null,
        message.attachments && message.attachments.length > 0 ? JSON.stringify(message.attachments) : null,
        message.model ?? null,
        message.promptVersion ?? null,
        message.tokensIn ?? null,
        message.tokensCached ?? null,
        message.tokensOut ?? null,
        message.costUsd ?? null,
        message.reasoning || null,
        message.revises ?? null,
      ],
    );
    await client.query(`UPDATE agent_conversations SET last_message_at = now() WHERE id = $1`, [conversationId]);
    return rows[0]!;
  }

  /** The person's own ratings of the answers in a conversation. */
  async ratings(client: pg.PoolClient, conversationId: string): Promise<Map<string, 1 | -1>> {
    const { rows } = await client.query<{ message_id: string; rating: 1 | -1 }>(
      `SELECT f.message_id, f.rating FROM agent_feedback f
         JOIN agent_messages m ON m.id = f.message_id
        WHERE m.conversation_id = $1`,
      [conversationId],
    );
    return new Map(rows.map((r) => [r.message_id, r.rating]));
  }

  // ─────────────────────────────────────────────────────────────── attachments

  async attachments(client: pg.PoolClient, conversationId: string): Promise<AttachmentRow[]> {
    const { rows } = await client.query<AttachmentRow>(
      `SELECT id, name, rows -> 0 AS rows, row_count, column_count, expires_at, kind, pages,
              char_length(text) AS text_length
         FROM agent_attachments WHERE conversation_id = $1 AND expires_at > now()
        ORDER BY created_at, id`,
      [conversationId],
    );
    // Only the first line was read: `rows` holds it.
    return rows.map((r) => ({ ...r, rows: [(r.rows as unknown as string[] | null) ?? []] }));
  }

  /**
   * A read's answer in this conversation, by its source handle — what
   * `present` lays out. Only the conversation's own tool answers: a handle
   * from anywhere else finds nothing.
   */
  async source(
    client: pg.PoolClient,
    conversationId: string,
    sourceId: string,
  ): Promise<Pick<MessageRow, 'content' | 'tool_name' | 'created_at'> | null> {
    const { rows } = await client.query<Pick<MessageRow, 'content' | 'tool_name' | 'created_at'>>(
      `SELECT content, tool_name, created_at FROM agent_messages
        WHERE conversation_id = $1 AND role = 'tool' AND starts_with(content, $2)
        ORDER BY created_at DESC LIMIT 1`,
      [conversationId, sourcePrefix(sourceId)],
    );
    return rows[0] ?? null;
  }

  /** A whole table attached in this conversation. */
  async table(client: pg.PoolClient, conversationId: string, id: string): Promise<AttachmentRow | null> {
    const { rows } = await client.query<AttachmentRow>(
      `SELECT id, name, rows, row_count, column_count, expires_at, kind, pages, NULL::int AS text_length
         FROM agent_attachments
        WHERE id = $1 AND conversation_id = $2 AND expires_at > now() AND kind = 'table'`,
      [id, conversationId],
    );
    return rows[0] ?? null;
  }

  /** A document attached in this conversation, with its text. */
  async document(
    client: pg.PoolClient,
    conversationId: string,
    id: string,
  ): Promise<{ id: string; name: string; text: string; pages: number | null } | null> {
    const { rows } = await client.query<{ id: string; name: string; text: string; pages: number | null }>(
      `SELECT id, name, text, pages FROM agent_attachments
        WHERE id = $1 AND conversation_id = $2 AND expires_at > now() AND kind = 'document'`,
      [id, conversationId],
    );
    return rows[0] ?? null;
  }
}

// ──────────────────────────────────────────────────────────────────── views

export function conversationView(row: ConversationRow): AgentConversationSummary {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    lastMessageAt: row.last_message_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    pinnedAt: row.pinned_at?.toISOString() ?? null,
    summarizedThrough: row.summary_through_id ?? null,
    summarizedAt: row.summarized_at?.toISOString() ?? null,
  };
}

export function messageView(
  row: MessageRow,
  summaries: ReadonlyMap<string, string>,
  /** What the conversation around it says of it: superseded by an edit, and the reader's rating. */
  around: { superseded?: boolean; rating?: 1 | -1 | null } = {},
): AgentMessageView {
  return {
    id: row.id,
    role: row.role,
    // A tool's answer as the page uses it: a card whole, anything else as the model rereads it.
    content: row.role === 'tool' ? forPage(row.content, row.tool_name) : row.content,
    toolCalls: (row.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.name,
      summary: summaries.get(call.name) ?? call.name,
    })),
    toolName: row.tool_name,
    attachments: row.attachments ?? [],
    model: row.model,
    reasoning: row.reasoning,
    revises: row.revises ?? null,
    superseded: around.superseded ?? false,
    rating: around.rating ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export function attachmentView(row: AttachmentRow): AgentAttachmentView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    rowCount: row.row_count,
    columnCount: row.column_count,
    pages: row.pages ?? null,
    characters: row.kind === 'document' ? (row.text_length ?? 0) : null,
    firstRow: row.rows[0] ?? [],
    expiresAt: row.expires_at.toISOString(),
  };
}
