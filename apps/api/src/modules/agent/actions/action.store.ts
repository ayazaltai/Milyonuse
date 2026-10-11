import { Injectable } from '@nestjs/common';
import type { AgentActionPreview, AgentActionStatus, AgentActionView } from '@milyonuse/contracts';
import type pg from 'pg';
import { AppError } from '../../../common/app-error.js';

/**
 * Actions (0009), read and written in the person's own scope — the database
 * holds every rule (what is proposed is fixed, it runs once, within a day);
 * this only arranges the statements.
 */

export interface ActionRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  tool_call_id: string | null;
  tool: string;
  connection_id: string | null;
  connection_name: string | null;
  connection_provider: string | null;
  args: Record<string, unknown>;
  preview: AgentActionPreview;
  risk: 'safe' | 'caution' | 'danger';
  reversible: boolean;
  reason: string;
  item_count: number;
  auto_confirmed: boolean;
  undo_of: string | null;
  status: AgentActionStatus;
  processed: number;
  succeeded: number;
  failed: number;
  uncertain: number;
  claimed_through: number;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: Date;
  expires_at: Date;
  confirmed_at: Date | null;
  finished_at: Date | null;
  /** An undo of this one was already proposed. */
  undone: boolean;
}

export interface NewAction {
  conversationId: string;
  messageId?: string | null | undefined;
  toolCallId?: string | null | undefined;
  tool: string;
  connectionId?: string | null | undefined;
  args: Record<string, unknown>;
  preview: AgentActionPreview;
  risk: 'safe' | 'caution' | 'danger';
  reversible: boolean;
  reason: string;
  itemCount: number;
  autoConfirmed: boolean;
  undoOf?: string | null | undefined;
}

const SELECT = `
  SELECT a.id, a.conversation_id, a.message_id, a.tool_call_id, a.tool, a.connection_id,
         c.name AS connection_name, c.provider AS connection_provider,
         a.args, a.preview, a.risk, a.reversible, a.reason, a.item_count, a.auto_confirmed, a.undo_of,
         a.status::text AS status, a.processed, a.succeeded, a.failed, a.uncertain, a.claimed_through,
         a.result, a.error, a.created_at, a.expires_at, a.confirmed_at, a.finished_at,
         EXISTS (SELECT 1 FROM agent_actions u WHERE u.undo_of = a.id AND u.status NOT IN ('discarded', 'expired')) AS undone
    FROM agent_actions a
    LEFT JOIN connections c ON c.id = a.connection_id`;

@Injectable()
export class ActionStore {
  async insert(client: pg.PoolClient, owner: { organizationId: string; memberId: string }, input: NewAction): Promise<ActionRow> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO agent_actions (organization_id, member_id, conversation_id, message_id, tool_call_id, tool, connection_id,
                                  args, preview, risk, reversible, reason, item_count, auto_confirmed, undo_of)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [
        owner.organizationId,
        owner.memberId,
        input.conversationId,
        input.messageId ?? null,
        input.toolCallId ?? null,
        input.tool,
        input.connectionId ?? null,
        JSON.stringify(input.args),
        JSON.stringify(input.preview),
        input.risk,
        input.reversible,
        input.reason.slice(0, 300),
        input.itemCount,
        input.autoConfirmed,
        input.undoOf ?? null,
      ],
    );
    return this.get(client, rows[0]!.id);
  }

  async get(client: pg.PoolClient, id: string, options: { lock?: boolean } = {}): Promise<ActionRow> {
    if (options.lock) await client.query(`SELECT 1 FROM agent_actions WHERE id = $1 FOR UPDATE`, [id]);
    const { rows } = await client.query<ActionRow>(`${SELECT} WHERE a.id = $1`, [id]);
    if (!rows[0]) throw AppError.notFound('Action');
    return rows[0];
  }

  async list(
    client: pg.PoolClient,
    filter: { conversationId?: string | undefined; status?: AgentActionStatus | undefined; since?: Date | undefined },
    limit = 100,
  ): Promise<ActionRow[]> {
    const { rows } = await client.query<ActionRow>(
      `${SELECT}
        WHERE ($1::ulid IS NULL OR a.conversation_id = $1)
          AND ($2::agent_action_status IS NULL OR a.status = $2)
          AND ($3::timestamptz IS NULL OR a.created_at >= $3)
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $4`,
      [filter.conversationId ?? null, filter.status ?? null, filter.since ?? null, limit],
    );
    return rows;
  }

  async start(client: pg.PoolClient, id: string): Promise<void> {
    await client.query(`UPDATE agent_actions SET status = 'running' WHERE id = $1`, [id]);
  }

  async discard(client: pg.PoolClient, id: string): Promise<void> {
    await client.query(`UPDATE agent_actions SET status = 'discarded' WHERE id = $1`, [id]);
  }

  async progress(
    client: pg.PoolClient,
    id: string,
    p: { claimedThrough: number; processed: number; succeeded: number; failed: number; uncertain: number },
  ): Promise<void> {
    await client.query(
      `UPDATE agent_actions SET claimed_through = $2, processed = $3, succeeded = $4, failed = $5, uncertain = $6 WHERE id = $1`,
      [id, p.claimedThrough, p.processed, p.succeeded, p.failed, p.uncertain],
    );
  }

  async finish(
    client: pg.PoolClient,
    id: string,
    outcome: { status: 'completed' | 'failed'; result?: Record<string, unknown> | null; error?: string | null },
  ): Promise<void> {
    await client.query(`UPDATE agent_actions SET result = $2, error = $3 WHERE id = $1`, [
      id,
      outcome.result ? JSON.stringify(outcome.result) : null,
      outcome.error?.slice(0, 2000) ?? null,
    ]);
    await client.query(`UPDATE agent_actions SET status = $2 WHERE id = $1`, [id, outcome.status]);
  }

  // ───────────────────────────────────────────────────────────────── items

  async addItems(client: pg.PoolClient, owner: { organizationId: string; memberId: string }, id: string, inputs: unknown[]): Promise<void> {
    for (let i = 0; i < inputs.length; i += 500) {
      const slice = inputs.slice(i, i + 500);
      await client.query(
        `INSERT INTO agent_action_items (action_id, seq, organization_id, member_id, input)
         SELECT $1, $2 + ord, $3, $4, item FROM jsonb_array_elements($5::jsonb) WITH ORDINALITY AS t(item, ord)`,
        [id, i, owner.organizationId, owner.memberId, JSON.stringify(slice)],
      );
    }
  }

  /** Claims the next items: each marked running before it runs, so a crash leaves it uncertain, never pending. */
  async claim(client: pg.PoolClient, id: string, count: number): Promise<{ seq: number; input: unknown }[]> {
    // MATERIALIZED: an IN (… LIMIT … FOR UPDATE) subquery is rescanned per row, skips the rows this
    // statement just changed, and so claims past its limit. The CTE picks the slice once.
    const { rows } = await client.query<{ seq: number; input: unknown }>(
      `WITH next AS MATERIALIZED (
         SELECT seq FROM agent_action_items WHERE action_id = $1 AND status = 'pending' ORDER BY seq LIMIT $2 FOR UPDATE)
       UPDATE agent_action_items i SET status = 'running'
         FROM next WHERE i.action_id = $1 AND i.seq = next.seq
       RETURNING i.seq, i.input`,
      [id, count],
    );
    return rows.sort((a, b) => a.seq - b.seq);
  }

  async settleItem(
    client: pg.PoolClient,
    id: string,
    seq: number,
    outcome: { status: 'succeeded' | 'failed' | 'uncertain'; result?: unknown; error?: string | null },
  ): Promise<void> {
    await client.query(`UPDATE agent_action_items SET status = $3, result = $4, error = $5 WHERE action_id = $1 AND seq = $2`, [
      id,
      seq,
      outcome.status,
      outcome.result === undefined ? null : JSON.stringify(outcome.result),
      outcome.error?.slice(0, 1000) ?? null,
    ]);
  }

  /** Items claimed and never settled — their process died with them: uncertain, never run again. */
  async abandonRunning(client: pg.PoolClient, id: string): Promise<number> {
    const { rowCount } = await client.query(
      `UPDATE agent_action_items SET status = 'uncertain', error = 'interrupted before it was known to finish'
        WHERE action_id = $1 AND status = 'running'`,
      [id],
    );
    return rowCount ?? 0;
  }

  async itemCounts(client: pg.PoolClient, id: string): Promise<Record<'pending' | 'running' | 'succeeded' | 'failed' | 'uncertain', number>> {
    const { rows } = await client.query<{ status: string; n: string }>(
      `SELECT status::text AS status, count(*)::text AS n FROM agent_action_items WHERE action_id = $1 GROUP BY status`,
      [id],
    );
    const counts = { pending: 0, running: 0, succeeded: 0, failed: 0, uncertain: 0 };
    for (const r of rows) counts[r.status as keyof typeof counts] = Number(r.n);
    return counts;
  }

  async itemResults(client: pg.PoolClient, id: string, limit = 50): Promise<{ seq: number; status: string; result: unknown; error: string | null }[]> {
    const { rows } = await client.query<{ seq: number; status: string; result: unknown; error: string | null }>(
      `SELECT seq, status::text AS status, result, error FROM agent_action_items WHERE action_id = $1 ORDER BY seq LIMIT $2`,
      [id, limit],
    );
    return rows;
  }
}

export function actionView(row: ActionRow, undoable: (row: ActionRow) => boolean): AgentActionView {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    tool: row.tool,
    connection:
      row.connection_id && row.connection_name && row.connection_provider
        ? { id: row.connection_id, name: row.connection_name, provider: row.connection_provider }
        : null,
    preview: row.preview,
    risk: row.risk,
    reversible: row.reversible,
    reason: row.reason,
    status: row.status,
    autoConfirmed: row.auto_confirmed,
    itemCount: row.item_count,
    processed: row.processed,
    succeeded: row.succeeded,
    failed: row.failed,
    uncertain: row.uncertain,
    result: row.result,
    error: row.error,
    undoOf: row.undo_of,
    undoable: row.status === 'completed' && !row.undone && undoable(row),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}
