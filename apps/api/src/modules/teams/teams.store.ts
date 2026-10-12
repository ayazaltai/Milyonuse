import { Injectable } from '@nestjs/common';
import type {
  Principal,
  RunStatus,
  RunStepView,
  RunSummaryView,
  RunTaskView,
  TaskStatus,
  TeamMemberView,
  TeamMode,
  TeamRole,
  TeamView,
} from '@milyonuse/contracts';
import type pg from 'pg';
import { AppError } from '../../common/app-error.js';
import { TenantScope } from '../tenancy/tenant-scope.service.js';

/**
 * Teams and runs (0012), read and written in the person's own scope: the
 * policies name the member, so another person's team or run is "not found".
 * The state machines are the database's; this file only asks.
 */

export type Owner = Pick<Principal, 'organizationId' | 'memberId'>;

export interface TeamRow {
  id: string;
  name: string;
  purpose: string;
  mode: TeamMode;
  budget_tokens: number;
  template: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  runs: number;
  last_run_at: Date | null;
}

export interface TeamMemberRow {
  team_id: string;
  agent_id: string;
  role: TeamRole;
  position: number;
  specialty: string;
  name: string;
  avatar: string;
  role_title: string;
  archived: boolean;
}

export interface RunRow {
  id: string;
  parent_run_id: string | null;
  team_id: string | null;
  /** A solo run's agent (an automation's target). */
  agent_id: string | null;
  automation_id: string | null;
  /** The policy an automation runs it under; the agents' own when null. */
  unattended_policy: 'safe_only' | 'trusted' | null;
  conversation_id: string;
  goal: string;
  mode: TeamMode | null;
  status: RunStatus;
  depth: number;
  budget_tokens: number;
  spent_tokens: string;
  revisions: number;
  result: string | null;
  error: string | null;
  lease_until: Date | null;
  created_at: Date;
  finished_at: Date | null;
}

export interface TaskRow {
  id: string;
  run_id: string;
  key: string;
  title: string;
  goal: string;
  context: string;
  success_criteria: string;
  depends_on: string[];
  assigned_agent_id: string | null;
  status: TaskStatus;
  attempts: number;
  output: string | null;
  error: string | null;
  tokens: number;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface StepRow {
  seq: number;
  kind: RunStepView['kind'];
  task_id: string | null;
  agent_id: string | null;
  summary: string;
  detail: Record<string, unknown>;
  tokens_in: number;
  tokens_out: number;
  created_at: Date;
}

export interface NewTask {
  key: string;
  title: string;
  goal: string;
  context?: string;
  successCriteria?: string;
  dependsOn?: string[];
  assignedAgentId?: string | null;
}

const TEAM = `t.id, t.name, t.purpose, t.mode::text AS mode, t.budget_tokens, t.template, t.archived_at, t.created_at, t.updated_at,
  (SELECT count(*)::int FROM runs r WHERE r.team_id = t.id AND r.parent_run_id IS NULL) AS runs,
  (SELECT max(r.created_at) FROM runs r WHERE r.team_id = t.id) AS last_run_at`;
const RUN = `r.id, r.parent_run_id, r.team_id, r.agent_id, r.automation_id, r.unattended_policy, r.conversation_id, r.goal, r.mode::text AS mode, r.status::text AS status, r.depth,
  r.budget_tokens, r.spent_tokens::text AS spent_tokens, r.revisions, r.result, r.error, r.lease_until, r.created_at, r.finished_at`;
const TASK = `k.id, k.run_id, k.key, k.title, k.goal, k.context, k.success_criteria, k.depends_on, k.assigned_agent_id,
  k.status::text AS status, k.attempts, k.output, k.error, k.tokens, k.started_at, k.finished_at`;

@Injectable()
export class TeamsStore {
  constructor(private readonly scope: TenantScope) {}

  run<T>(owner: Owner, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.scope.run({ organizationId: owner.organizationId, memberId: owner.memberId }, fn);
  }

  // ─────────────────────────────────────────────────────────────── teams

  async teams(client: pg.PoolClient, includeArchived: boolean): Promise<TeamRow[]> {
    const { rows } = await client.query<TeamRow>(
      `SELECT ${TEAM} FROM teams t WHERE ($1 OR t.archived_at IS NULL) ORDER BY t.archived_at NULLS FIRST, t.created_at`,
      [includeArchived],
    );
    return rows;
  }

  async team(client: pg.PoolClient, id: string, lock = false): Promise<TeamRow> {
    const { rows } = await client.query<TeamRow>(`SELECT ${TEAM} FROM teams t WHERE t.id = $1${lock ? ' FOR UPDATE OF t' : ''}`, [id]);
    if (!rows[0]) throw AppError.notFound('Team');
    return rows[0];
  }

  async countTeams(client: pg.PoolClient): Promise<number> {
    const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM teams WHERE archived_at IS NULL`);
    return rows[0]!.n;
  }

  async members(client: pg.PoolClient, teamIds: readonly string[]): Promise<TeamMemberRow[]> {
    if (teamIds.length === 0) return [];
    const { rows } = await client.query<TeamMemberRow>(
      `SELECT m.team_id, m.agent_id, m.role, m.position, m.specialty, a.name, a.avatar, a.role_title, a.archived_at IS NOT NULL AS archived
         FROM team_members m JOIN agents a ON a.id = m.agent_id
        WHERE m.team_id::text = ANY ($1::text[])
        ORDER BY CASE m.role WHEN 'lead' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, m.position, m.created_at`,
      [teamIds],
    );
    return rows;
  }

  async createTeam(
    client: pg.PoolClient,
    owner: Owner,
    team: { name: string; purpose: string; mode: TeamMode; budgetTokens: number; template: string | null },
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO teams (organization_id, member_id, name, purpose, mode, budget_tokens, template)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [owner.organizationId, owner.memberId, team.name, team.purpose, team.mode, team.budgetTokens, team.template],
    );
    return rows[0]!.id;
  }

  async updateTeam(
    client: pg.PoolClient,
    id: string,
    change: { name?: string | undefined; purpose?: string | undefined; mode?: TeamMode | undefined; budgetTokens?: number | undefined },
  ): Promise<void> {
    await client.query(
      `UPDATE teams SET name = COALESCE($2, name), purpose = COALESCE($3, purpose), mode = COALESCE($4::team_mode, mode),
              budget_tokens = COALESCE($5, budget_tokens)
        WHERE id = $1`,
      [id, change.name ?? null, change.purpose ?? null, change.mode ?? null, change.budgetTokens ?? null],
    );
  }

  /** The roster, replaced whole: what a team is is who is on it now. */
  async setMembers(
    client: pg.PoolClient,
    owner: Owner,
    teamId: string,
    members: readonly { agentId: string; role: TeamRole; position: number; specialty: string }[],
  ): Promise<void> {
    await client.query(`DELETE FROM team_members WHERE team_id = $1`, [teamId]);
    for (const m of members) {
      await client.query(
        `INSERT INTO team_members (organization_id, member_id, team_id, agent_id, role, position, specialty)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [owner.organizationId, owner.memberId, teamId, m.agentId, m.role, m.position, m.specialty],
      );
    }
  }

  async setArchived(client: pg.PoolClient, id: string, archived: boolean): Promise<void> {
    await client.query(`UPDATE teams SET archived_at = CASE WHEN $2 THEN COALESCE(archived_at, now()) ELSE NULL END WHERE id = $1`, [id, archived]);
  }

  // ──────────────────────────────────────────────────────────────── runs

  async createRun(
    client: pg.PoolClient,
    owner: Owner,
    run: {
      teamId: string | null;
      agentId?: string | null;
      conversationId: string;
      goal: string;
      mode: TeamMode | null;
      budgetTokens: number;
      automationId?: string | null;
      policy?: 'safe_only' | 'trusted' | null;
    },
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO runs (organization_id, member_id, team_id, agent_id, conversation_id, goal, mode, budget_tokens, automation_id, unattended_policy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        owner.organizationId,
        owner.memberId,
        run.teamId,
        run.agentId ?? null,
        run.conversationId,
        run.goal,
        run.mode,
        run.budgetTokens,
        run.automationId ?? null,
        run.policy ?? null,
      ],
    );
    return rows[0]!.id;
  }

  async getRun(client: pg.PoolClient, id: string, lock = false): Promise<RunRow> {
    const { rows } = await client.query<RunRow>(`SELECT ${RUN} FROM runs r WHERE r.id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!rows[0]) throw AppError.notFound('Run');
    return rows[0];
  }

  async runs(
    client: pg.PoolClient,
    filter: { teamId?: string | undefined; automationId?: string | undefined; status?: string | undefined },
    limit = 50,
  ): Promise<RunRow[]> {
    const { rows } = await client.query<RunRow>(
      `SELECT ${RUN} FROM runs r WHERE r.parent_run_id IS NULL AND ($1::text IS NULL OR r.team_id::text = $1)
          AND ($3::text IS NULL OR r.automation_id::text = $3) AND ($4::text IS NULL OR r.status::text = $4)
        ORDER BY r.created_at DESC LIMIT $2`,
      [filter.teamId ?? null, limit, filter.automationId ?? null, filter.status ?? null],
    );
    return rows;
  }

  /**
   * Holds the run for one slice: only one process advances it at a time. A
   * lease that ran out belongs to a process that died, and is taken over.
   */
  async lease(client: pg.PoolClient, id: string, seconds: number): Promise<RunRow | null> {
    const { rows } = await client.query<RunRow>(
      `UPDATE runs r SET lease_until = clock_timestamp() + make_interval(secs => $2)
        WHERE r.id = $1 AND r.status IN ('queued', 'running') AND (r.lease_until IS NULL OR r.lease_until < clock_timestamp())
        RETURNING ${RUN}`,
      [id, seconds],
    );
    return rows[0] ?? null;
  }

  async release(client: pg.PoolClient, id: string): Promise<void> {
    await client.query(`UPDATE runs SET lease_until = NULL WHERE id = $1 AND status NOT IN ('completed', 'cancelled')`, [id]);
  }

  async setRunStatus(
    client: pg.PoolClient,
    id: string,
    status: RunStatus,
    change: { result?: string; error?: string | null; addBudget?: number } = {},
  ): Promise<void> {
    await client.query(
      `UPDATE runs SET status = $2::run_status, result = COALESCE($3, result),
              error = CASE WHEN $4::boolean THEN $5 ELSE error END,
              budget_tokens = budget_tokens + $6
        WHERE id = $1`,
      [id, status, change.result ?? null, change.error !== undefined, change.error ?? null, change.addBudget ?? 0],
    );
  }

  async spend(client: pg.PoolClient, id: string, tokens: number): Promise<void> {
    // A call that ends after the run was stopped is counted to the day, not to a sealed run.
    if (tokens > 0) await client.query(`UPDATE runs SET spent_tokens = spent_tokens + $2 WHERE id = $1 AND status NOT IN ('completed', 'cancelled')`, [id, tokens]);
  }

  async addRevision(client: pg.PoolClient, id: string): Promise<void> {
    await client.query(`UPDATE runs SET revisions = revisions + 1 WHERE id = $1`, [id]);
  }

  // ─────────────────────────────────────────────────────────────── tasks

  async tasks(client: pg.PoolClient, runId: string): Promise<TaskRow[]> {
    const { rows } = await client.query<TaskRow>(`SELECT ${TASK} FROM run_tasks k WHERE k.run_id = $1 ORDER BY k.created_at, k.id`, [runId]);
    return rows;
  }

  async addTask(client: pg.PoolClient, owner: Owner, runId: string, t: NewTask): Promise<void> {
    await client.query(
      `INSERT INTO run_tasks (organization_id, member_id, run_id, key, title, goal, context, success_criteria, depends_on, assigned_agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        owner.organizationId,
        owner.memberId,
        runId,
        t.key,
        t.title,
        t.goal,
        t.context ?? '',
        t.successCriteria ?? '',
        t.dependsOn ?? [],
        t.assignedAgentId ?? null,
      ],
    );
  }

  async startTask(client: pg.PoolClient, id: string): Promise<boolean> {
    const { rowCount } = await client.query(`UPDATE run_tasks SET status = 'running' WHERE id = $1 AND status = 'pending'`, [id]);
    return (rowCount ?? 0) > 0;
  }

  async finishTask(
    client: pg.PoolClient,
    id: string,
    outcome: { status: 'done' | 'failed' | 'uncertain' | 'cancelled'; output?: string; error?: string; tokens?: number },
  ): Promise<void> {
    await client.query(
      `UPDATE run_tasks SET status = $2::task_status, output = COALESCE($3, output), error = $4, tokens = tokens + $5
        WHERE id = $1 AND status = 'running'`,
      [id, outcome.status, outcome.output ?? null, outcome.error ?? null, outcome.tokens ?? 0],
    );
  }

  /** A new attempt: a failed or interrupted task waits again — for another member, or the same one on a rerun. */
  async retryTask(client: pg.PoolClient, id: string, agentId: string | null): Promise<void> {
    await client.query(
      `UPDATE run_tasks SET status = 'pending', attempts = attempts + 1, assigned_agent_id = COALESCE($2, assigned_agent_id)
        WHERE id = $1 AND status IN ('failed', 'uncertain', 'cancelled')`,
      [id, agentId],
    );
  }

  async reassign(client: pg.PoolClient, id: string, agentId: string): Promise<boolean> {
    const { rowCount } = await client.query(`UPDATE run_tasks SET assigned_agent_id = $2 WHERE id = $1 AND status = 'pending'`, [id, agentId]);
    return (rowCount ?? 0) > 0;
  }

  /** Tasks left running by a slice that ended without finishing them — a process that died mid-call. */
  async interrupt(client: pg.PoolClient, runId: string): Promise<string[]> {
    const { rows } = await client.query<{ key: string }>(
      `UPDATE run_tasks SET status = 'uncertain', error = 'Interrupted mid-way; not run a second time on its own.'
        WHERE run_id = $1 AND status = 'running' RETURNING key`,
      [runId],
    );
    return rows.map((r) => r.key);
  }

  async cancelOpenTasks(client: pg.PoolClient, runId: string): Promise<void> {
    await client.query(`UPDATE run_tasks SET status = 'cancelled' WHERE run_id = $1 AND status IN ('pending', 'running')`, [runId]);
  }

  // ─────────────────────────────────────────────────────────────── steps

  async step(
    client: pg.PoolClient,
    owner: Owner,
    runId: string,
    step: {
      kind: RunStepView['kind'];
      summary: string;
      taskId?: string | null;
      agentId?: string | null;
      detail?: Record<string, unknown>;
      tokensIn?: number;
      tokensOut?: number;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO run_steps (organization_id, member_id, run_id, task_id, seq, kind, agent_id, summary, detail, tokens_in, tokens_out)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10)`,
      [
        owner.organizationId,
        owner.memberId,
        runId,
        step.taskId ?? null,
        step.kind,
        step.agentId ?? null,
        step.summary.replace(/\s+/g, ' ').trim().slice(0, 500) || step.kind,
        JSON.stringify(step.detail ?? {}),
        step.tokensIn ?? 0,
        step.tokensOut ?? 0,
      ],
    );
  }

  async steps(client: pg.PoolClient, runId: string): Promise<StepRow[]> {
    const { rows } = await client.query<StepRow>(
      `SELECT seq, kind, task_id, agent_id, summary, detail, tokens_in, tokens_out, created_at FROM run_steps WHERE run_id = $1 ORDER BY seq`,
      [runId],
    );
    return rows;
  }

  /** The latest step of a kind — the draft a merge wrote, the reviewer's word. */
  async lastStep(client: pg.PoolClient, runId: string, kinds: readonly RunStepView['kind'][]): Promise<StepRow | null> {
    const { rows } = await client.query<StepRow>(
      `SELECT seq, kind, task_id, agent_id, summary, detail, tokens_in, tokens_out, created_at FROM run_steps
        WHERE run_id = $1 AND kind = ANY ($2::text[]) ORDER BY seq DESC LIMIT 1`,
      [runId, kinds],
    );
    return rows[0] ?? null;
  }

  async proposals(client: pg.PoolClient, conversationId: string): Promise<number> {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agent_actions WHERE conversation_id = $1 AND status = 'proposed'`,
      [conversationId],
    );
    return rows[0]!.n;
  }
}

// ───────────────────────────────────────────────────────────────── views

export function memberView(row: TeamMemberRow): TeamMemberView {
  return {
    agentId: row.agent_id,
    name: row.name,
    avatar: row.avatar,
    roleTitle: row.role_title,
    role: row.role,
    position: row.position,
    specialty: row.specialty,
    archived: row.archived,
  };
}

export function teamView(row: TeamRow, members: readonly TeamMemberRow[]): TeamView {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    mode: row.mode,
    budgetTokens: row.budget_tokens,
    template: row.template,
    archivedAt: row.archived_at?.toISOString() ?? null,
    members: members.filter((m) => m.team_id === row.id).map(memberView),
    runs: row.runs,
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function runSummary(row: RunRow): RunSummaryView {
  return {
    id: row.id,
    teamId: row.team_id,
    agentId: row.agent_id,
    automationId: row.automation_id,
    conversationId: row.conversation_id,
    goal: row.goal,
    mode: row.mode,
    status: row.status,
    budgetTokens: row.budget_tokens,
    spentTokens: Number(row.spent_tokens),
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

export function taskView(row: TaskRow): RunTaskView {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    goal: row.goal,
    context: row.context,
    successCriteria: row.success_criteria,
    dependsOn: row.depends_on,
    assignedAgentId: row.assigned_agent_id,
    status: row.status,
    attempts: row.attempts,
    output: row.output,
    error: row.error,
    tokens: row.tokens,
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

export function stepView(row: StepRow, tasks: readonly TaskRow[]): RunStepView {
  return {
    seq: row.seq,
    kind: row.kind,
    taskKey: row.task_id ? (tasks.find((t) => t.id === row.task_id)?.key ?? null) : null,
    agentId: row.agent_id,
    summary: row.summary,
    tokens: row.tokens_in + row.tokens_out,
    createdAt: row.created_at.toISOString(),
  };
}
