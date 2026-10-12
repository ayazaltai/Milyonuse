import { Injectable } from '@nestjs/common';
import type { AutomationKind, AutomationTriggerView, Cadence, Principal } from '@milyonuse/contracts';
import type pg from 'pg';
import { AppError } from '../../common/app-error.js';
import { TenantScope } from '../tenancy/tenant-scope.service.js';

/**
 * Automations, their triggers, monitor state and the inbox (0013), in the
 * person's own scope. What the database decides — the next run, the pause
 * after three failures, one run per event, chains — it decides; this file
 * asks.
 */

export type Owner = Pick<Principal, 'organizationId' | 'memberId'>;

export interface AutomationRow {
  id: string;
  name: string;
  kind: AutomationKind;
  enabled: boolean;
  target_agent_id: string | null;
  target_team_id: string | null;
  target_name: string;
  prompt: string;
  policy: 'safe_only' | 'trusted';
  trusted_confirmed_at: Date | null;
  time_zone: string;
  quiet_start: string | null;
  quiet_end: string | null;
  budget_tokens: number;
  daily_cap: number;
  failure_policy: 'retry' | 'pause' | 'notify';
  notify: ('inbox' | 'email')[];
  cadence: Cadence | null;
  weekdays: number[];
  month_day: number | null;
  local_time: string | null;
  every_hours: number | null;
  next_run_at: Date | null;
  monitor_url: string | null;
  monitor_condition: string | null;
  goal_until: string | null;
  hook_token: string | null;
  watch_automation_id: string | null;
  watch_team_id: string | null;
  watch_events: ('run.completed' | 'run.failed')[];
  consecutive_failures: number;
  paused_reason: string | null;
  last_run_at: Date | null;
  last_outcome: 'completed' | 'failed' | 'skipped' | 'waiting' | null;
  created_at: Date;
  updated_at: Date;
}

export interface TriggerRow {
  id: string;
  automation_id: string;
  source: AutomationTriggerView['source'];
  dedupe_key: string;
  payload: Record<string, unknown>;
  chain: string[];
  status: AutomationTriggerView['status'];
  reason: string | null;
  run_id: string | null;
  created_at: Date;
}

export interface MonitorRow {
  last_hash: string | null;
  last_excerpt: string | null;
  checks: number;
  changes: number;
  last_checked_at: Date | null;
  last_changed_at: Date | null;
}

/** Columns a create or an update may set, by their names in the table. */
export type AutomationColumns = Partial<{
  name: string;
  kind: AutomationKind;
  enabled: boolean;
  target_agent_id: string | null;
  target_team_id: string | null;
  prompt: string;
  policy: 'safe_only' | 'trusted';
  trusted_confirmed_at: Date | null;
  time_zone: string;
  quiet_start: string | null;
  quiet_end: string | null;
  budget_tokens: number;
  daily_cap: number;
  failure_policy: string;
  notify: string[];
  cadence: string | null;
  weekdays: number[];
  month_day: number | null;
  local_time: string | null;
  every_hours: number | null;
  monitor_url: string | null;
  monitor_condition: string | null;
  goal_until: string | null;
  hook_token: string | null;
  watch_automation_id: string | null;
  watch_team_id: string | null;
  watch_events: string[];
  consecutive_failures: number;
  paused_reason: string | null;
  last_run_at: Date | null;
  last_outcome: string | null;
}>;

const CASTS: Record<string, string> = {
  weekdays: '::smallint[]',
  notify: '::text[]',
  watch_events: '::text[]',
  kind: '::automation_kind',
  local_time: '::time',
  quiet_start: '::time',
  quiet_end: '::time',
  goal_until: '::date',
};

const AUTOMATION = `a.id, a.name, a.kind::text AS kind, a.enabled, a.target_agent_id, a.target_team_id,
  COALESCE((SELECT g.name FROM agents g WHERE g.id = a.target_agent_id), (SELECT t.name FROM teams t WHERE t.id = a.target_team_id), '') AS target_name,
  a.prompt, a.policy, a.trusted_confirmed_at, a.time_zone, to_char(a.quiet_start, 'HH24:MI') AS quiet_start,
  to_char(a.quiet_end, 'HH24:MI') AS quiet_end, a.budget_tokens, a.daily_cap, a.failure_policy, a.notify, a.cadence,
  a.weekdays::int[] AS weekdays, a.month_day, to_char(a.local_time, 'HH24:MI') AS local_time, a.every_hours, a.next_run_at,
  a.monitor_url, a.monitor_condition, to_char(a.goal_until, 'YYYY-MM-DD') AS goal_until, a.hook_token,
  a.watch_automation_id, a.watch_team_id, a.watch_events, a.consecutive_failures, a.paused_reason, a.last_run_at,
  a.last_outcome, a.created_at, a.updated_at`;
const TRIGGER = `id, automation_id, source, dedupe_key, payload, chain::text[] AS chain, status, reason, run_id, created_at`;

@Injectable()
export class AutomationsStore {
  constructor(private readonly scope: TenantScope) {}

  run<T>(owner: Owner, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.scope.run({ organizationId: owner.organizationId, memberId: owner.memberId }, fn);
  }

  async list(client: pg.PoolClient): Promise<AutomationRow[]> {
    const { rows } = await client.query<AutomationRow>(`SELECT ${AUTOMATION} FROM automations a ORDER BY a.created_at`);
    return rows;
  }

  async get(client: pg.PoolClient, id: string, lock = false): Promise<AutomationRow> {
    const { rows } = await client.query<AutomationRow>(`SELECT ${AUTOMATION} FROM automations a WHERE a.id = $1${lock ? ' FOR UPDATE OF a' : ''}`, [id]);
    if (!rows[0]) throw AppError.notFound('Automation');
    return rows[0];
  }

  async create(client: pg.PoolClient, owner: Owner, columns: AutomationColumns): Promise<string> {
    const entries = Object.entries(columns).filter(([, v]) => v !== undefined);
    const names = ['organization_id', 'member_id', ...entries.map(([k]) => k)];
    const values = [owner.organizationId, owner.memberId, ...entries.map(([, v]) => v)];
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO automations (${names.join(', ')}) VALUES (${names.map((n, i) => `$${i + 1}${CASTS[n] ?? ''}`).join(', ')}) RETURNING id`,
      values,
    );
    return rows[0]!.id;
  }

  async update(client: pg.PoolClient, id: string, columns: AutomationColumns): Promise<void> {
    const entries = Object.entries(columns).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    await client.query(
      `UPDATE automations SET ${entries.map(([k], i) => `${k} = $${i + 2}${CASTS[k] ?? ''}`).join(', ')} WHERE id = $1`,
      [id, ...entries.map(([, v]) => v)],
    );
  }

  async remove(client: pg.PoolClient, id: string): Promise<boolean> {
    const { rowCount } = await client.query(`DELETE FROM automations WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  /** The automations that follow a run's automation or team, for an outcome. */
  async followers(client: pg.PoolClient, ended: { automationId: string | null; teamId: string | null }, event: string): Promise<AutomationRow[]> {
    const { rows } = await client.query<AutomationRow>(
      `SELECT ${AUTOMATION} FROM automations a
        WHERE a.kind = 'agent_event' AND a.enabled AND $3 = ANY (a.watch_events)
          AND ((a.watch_automation_id IS NOT NULL AND a.watch_automation_id::text = $1)
            OR (a.watch_team_id IS NOT NULL AND a.watch_team_id::text = $2))`,
      [ended.automationId, ended.teamId, event],
    );
    return rows;
  }

  // ──────────────────────────────────────────────────────────── triggers

  /** Records an event once: the same dedupe key again answers null. Loops and deep chains are the database's to refuse. */
  async addTrigger(
    client: pg.PoolClient,
    owner: Owner,
    automationId: string,
    t: { source: TriggerRow['source']; dedupeKey: string; payload?: Record<string, unknown>; chain?: string[] },
  ): Promise<TriggerRow | null> {
    const { rows } = await client.query<TriggerRow>(
      `INSERT INTO automation_triggers (organization_id, member_id, automation_id, source, dedupe_key, payload, chain)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[]::ulid[])
       ON CONFLICT ON CONSTRAINT automation_triggers_once DO NOTHING
       RETURNING ${TRIGGER}`,
      [owner.organizationId, owner.memberId, automationId, t.source, t.dedupeKey.slice(0, 200), JSON.stringify(t.payload ?? {}), t.chain ?? []],
    );
    return rows[0] ?? null;
  }

  async trigger(client: pg.PoolClient, id: string, lock = false): Promise<TriggerRow> {
    const { rows } = await client.query<TriggerRow>(`SELECT ${TRIGGER} FROM automation_triggers WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!rows[0]) throw AppError.notFound('Trigger');
    return rows[0];
  }

  async triggers(client: pg.PoolClient, automationId: string, limit = 30): Promise<TriggerRow[]> {
    const { rows } = await client.query<TriggerRow>(
      `SELECT ${TRIGGER} FROM automation_triggers WHERE automation_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [automationId, limit],
    );
    return rows;
  }

  async decide(client: pg.PoolClient, id: string, status: 'started' | 'skipped' | 'failed', change: { reason?: string; runId?: string } = {}): Promise<void> {
    await client.query(`UPDATE automation_triggers SET status = $2, reason = $3, run_id = $4 WHERE id = $1 AND status = 'accepted'`, [
      id,
      status,
      change.reason?.slice(0, 500) ?? null,
      change.runId ?? null,
    ]);
  }

  /** Runs an automation started today, in its own time zone — what its daily cap counts. */
  async startedToday(client: pg.PoolClient, automationId: string, timeZone: string): Promise<number> {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM automation_triggers
        WHERE automation_id = $1 AND status = 'started'
          AND (created_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`,
      [automationId, timeZone],
    );
    return rows[0]!.n;
  }

  /** The chain a run's automation event carried. */
  async chainOf(client: pg.PoolClient, runId: string): Promise<string[]> {
    const { rows } = await client.query<{ chain: string[] }>(`SELECT chain::text[] AS chain FROM automation_triggers WHERE run_id = $1 LIMIT 1`, [runId]);
    return rows[0]?.chain ?? [];
  }

  // ───────────────────────────────────────────────────────────── monitors

  async monitor(client: pg.PoolClient, automationId: string): Promise<MonitorRow | null> {
    const { rows } = await client.query<MonitorRow>(
      `SELECT last_hash, last_excerpt, checks, changes, last_checked_at, last_changed_at FROM monitor_state WHERE automation_id = $1`,
      [automationId],
    );
    return rows[0] ?? null;
  }

  async observe(client: pg.PoolClient, owner: Owner, automationId: string, hash: string, excerpt: string, changed: boolean): Promise<void> {
    await client.query(
      `INSERT INTO monitor_state (automation_id, organization_id, member_id, last_hash, last_excerpt, checks, changes, last_checked_at, last_changed_at)
       VALUES ($1, $2, $3, $4, $5, 1, 0, now(), NULL)
       ON CONFLICT (automation_id) DO UPDATE
         SET last_hash = EXCLUDED.last_hash, last_excerpt = EXCLUDED.last_excerpt, checks = monitor_state.checks + 1,
             changes = monitor_state.changes + CASE WHEN $6 THEN 1 ELSE 0 END,
             last_checked_at = now(), last_changed_at = CASE WHEN $6 THEN now() ELSE monitor_state.last_changed_at END`,
      [automationId, owner.organizationId, owner.memberId, hash, excerpt.slice(0, 4000), changed],
    );
  }

  // ──────────────────────────────────────────────────────────────── inbox

  async addInboxItem(
    client: pg.PoolClient,
    owner: Owner,
    item: { kind: 'alert' | 'suggestion' | 'notice'; title: string; body?: string; link?: string | null; automationId?: string | null; payload?: unknown; dedupeKey?: string | null },
  ): Promise<void> {
    await client.query(
      `INSERT INTO inbox_items (organization_id, member_id, kind, title, body, link, automation_id, payload, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT ON CONSTRAINT inbox_items_once DO NOTHING`,
      [
        owner.organizationId,
        owner.memberId,
        item.kind,
        item.title.slice(0, 200),
        (item.body ?? '').slice(0, 2000),
        item.link ?? null,
        item.automationId ?? null,
        JSON.stringify(item.payload ?? {}),
        item.dedupeKey ?? null,
      ],
    );
  }
}
