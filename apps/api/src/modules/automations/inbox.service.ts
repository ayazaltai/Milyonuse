import { Injectable } from '@nestjs/common';
import {
  type AgentActionPreview,
  type AgentActionRisk,
  type AutomationDraftView,
  type InboxCount,
  type InboxItemView,
  type InboxView,
  type Principal,
} from '@milyonuse/contracts';
import type pg from 'pg';
import { AppError } from '../../common/app-error.js';
import { ActionService } from '../agent/actions/action.service.js';
import { TeamsStore, runSummary } from '../teams/teams.store.js';
import { AutomationsStore } from './automations.store.js';

interface ItemRow {
  id: string;
  kind: InboxItemView['kind'];
  title: string;
  body: string;
  link: string | null;
  automation_id: string | null;
  payload: Record<string, unknown>;
  read_at: Date | null;
  created_at: Date;
}

const ITEM = `id, kind, title, body, link, automation_id, payload, read_at, created_at`;

/**
 * The Inbox (F6 §3): everything that waits for the person, in one place —
 * proposals the agent made, team runs waiting at their budget, memories
 * waiting for approval, and the automations' alerts, notices and
 * suggestions. Each is answered through the path that owns it (a proposal
 * through the ActionService, re-checked as it is then), never around it.
 */
@Injectable()
export class InboxService {
  constructor(
    private readonly store: AutomationsStore,
    private readonly teams: TeamsStore,
    private readonly actions: ActionService,
  ) {}

  async view(principal: Principal): Promise<InboxView> {
    return this.store.run(principal, async (client) => {
      const proposals = await client.query<{
        id: string;
        conversation_id: string;
        conversation_title: string;
        tool: string;
        preview: AgentActionPreview;
        risk: AgentActionRisk;
        reversible: boolean;
        created_at: Date;
        expires_at: Date;
      }>(
        `SELECT a.id, a.conversation_id, c.title AS conversation_title, a.tool, a.preview, a.risk, a.reversible, a.created_at, a.expires_at
           FROM agent_actions a JOIN agent_conversations c ON c.id = a.conversation_id
          WHERE a.status = 'proposed' AND a.expires_at > now()
          ORDER BY a.created_at DESC LIMIT 100`,
      );
      const memories = await client.query<{ id: string; content: string; tier: string; team_id: string | null; created_at: Date }>(
        `SELECT m.id, m.content, m.tier::text AS tier, CASE WHEN m.scope = 'team' THEN m.scope_ref END AS team_id, m.created_at
           FROM memory_items m
          WHERE m.state = 'pending' AND m.member_id IS NOT NULL
          ORDER BY m.created_at DESC LIMIT 100`,
      );
      const items = await client.query<ItemRow>(`SELECT ${ITEM} FROM inbox_items WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 100`);
      return {
        proposals: proposals.rows.map((r) => ({
          id: r.id,
          conversationId: r.conversation_id,
          conversationTitle: r.conversation_title,
          tool: r.tool,
          title: r.preview.title,
          risk: r.risk,
          reversible: r.reversible,
          createdAt: r.created_at.toISOString(),
          expiresAt: r.expires_at.toISOString(),
        })),
        waitingRuns: (await this.teams.runs(client, { status: 'waiting_approval' }, 100)).map(runSummary),
        memories: memories.rows.map((r) => ({ id: r.id, content: r.content, tier: r.tier, teamId: r.team_id, createdAt: r.created_at.toISOString() })),
        items: items.rows.map(itemView),
      };
    });
  }

  /** What the bell shows: everything waiting, and how much of it is new. */
  async count(principal: Principal): Promise<InboxCount> {
    return this.store.run(principal, async (client) => {
      const { rows } = await client.query<{ waiting: number; unread: number }>(
        `SELECT (SELECT count(*) FROM agent_actions WHERE status = 'proposed' AND expires_at > now())::int
              + (SELECT count(*) FROM runs WHERE status = 'waiting_approval' AND parent_run_id IS NULL)::int
              + (SELECT count(*) FROM memory_items WHERE state = 'pending' AND member_id IS NOT NULL)::int AS waiting,
                (SELECT count(*) FROM inbox_items WHERE resolved_at IS NULL AND read_at IS NULL)::int AS unread`,
      );
      const { rows: open } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM inbox_items WHERE resolved_at IS NULL`);
      return { total: rows[0]!.waiting + open[0]!.n, unread: rows[0]!.waiting + rows[0]!.unread };
    });
  }

  async markRead(principal: Principal, ids: string[] | 'all'): Promise<number> {
    return this.store.run(principal, async (client) => {
      const { rowCount } =
        ids === 'all'
          ? await client.query(`UPDATE inbox_items SET read_at = now() WHERE read_at IS NULL AND resolved_at IS NULL`)
          : await client.query(`UPDATE inbox_items SET read_at = now() WHERE read_at IS NULL AND id = ANY ($1::text[]::ulid[])`, [ids]);
      return rowCount ?? 0;
    });
  }

  /** Done with: an alert seen to, a suggestion taken up or turned down. */
  async resolve(principal: Principal, id: string): Promise<InboxItemView> {
    return this.store.run(principal, async (client) => {
      const { rows } = await client.query<ItemRow>(
        `UPDATE inbox_items SET resolved_at = COALESCE(resolved_at, now()), read_at = COALESCE(read_at, now()) WHERE id = $1 RETURNING ${ITEM}`,
        [id],
      );
      if (!rows[0]) throw AppError.notFound('Inbox item');
      return itemView(rows[0]);
    });
  }

  /**
   * Confirms or discards proposals together. Each goes through the same path
   * a single answer does — checked as it is now — so one refused does not
   * stop the rest; each answers for itself.
   */
  async bulk(
    principal: Principal,
    decision: 'confirm' | 'discard',
    ids: string[],
    timeZone?: string,
  ): Promise<{ results: { id: string; status: string | null; error: string | null }[] }> {
    const results: { id: string; status: string | null; error: string | null }[] = [];
    for (const id of ids) {
      try {
        const action =
          decision === 'confirm'
            ? await this.actions.confirm(principal, id, timeZone ? { timeZone } : {})
            : await this.actions.discard(principal, id);
        results.push({ id, status: action.status, error: null });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        results.push({ id, status: null, error: error.message });
      }
    }
    return { results };
  }

  /** For tests and the suggestion pass: the open items. */
  async items(client: pg.PoolClient): Promise<InboxItemView[]> {
    const { rows } = await client.query<ItemRow>(`SELECT ${ITEM} FROM inbox_items WHERE resolved_at IS NULL ORDER BY created_at DESC`);
    return rows.map(itemView);
  }
}

function itemView(row: ItemRow): InboxItemView {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    link: row.link,
    automationId: row.automation_id,
    suggestion: row.kind === 'suggestion' ? (row.payload as unknown as AutomationDraftView) : null,
    readAt: row.read_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}
