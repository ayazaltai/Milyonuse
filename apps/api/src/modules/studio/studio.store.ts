import { Injectable } from '@nestjs/common';
import type {
  AgentDefinition,
  Principal,
  SkillDetailView,
  SkillFindingView,
  SkillRunView,
  SkillSummaryView,
  SkillVerdict,
  SkillVersionView,
  StudioAgentVersionView,
  StudioAgentView,
} from '@milyonuse/contracts';
import type pg from 'pg';
import { AppError } from '../../common/app-error.js';
import { TenantScope } from '../tenancy/tenant-scope.service.js';

/**
 * The studio's records (0010), read and written in the person's own scope:
 * the policies name the member, so another person's agent or skill is "not
 * found". The rules — numbered immutable versions, a skill's life — are the
 * database's; this file only asks.
 */

export type Owner = Pick<Principal, 'organizationId' | 'memberId'>;

export interface AgentRow {
  id: string;
  name: string;
  avatar: string;
  role_title: string;
  template: string | null;
  current_version_id: string;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  conversations: number;
}

export interface AgentVersionRow {
  id: string;
  version: number;
  persona: string;
  instructions: string;
  model_tier: AgentDefinition['modelTier'];
  tools: string[];
  memory_scope: AgentDefinition['memoryScope'];
  autonomy: AgentDefinition['autonomy'];
  unattended_policy: AgentDefinition['unattendedPolicy'];
  budget_tokens: number;
  budget_sandbox_minutes: number;
  skills: string[];
  note: string | null;
  created_at: Date;
}

export interface SkillRow {
  id: string;
  name: string;
  source: 'bundled' | 'user' | 'learned';
  enabled: boolean;
  current_version_id: string | null;
  updated_at: Date;
}

export interface SkillVersionRow {
  id: string;
  skill_id: string;
  version: number;
  state: SkillVersionView['state'];
  description: string;
  content: string;
  files: { path: string; content: string }[];
  scan_verdict: SkillVerdict;
  findings: SkillFindingView[];
  source_conversation_id: string | null;
  source_run_id: string | null;
  task: string | null;
  derived_from: string[];
  state_reason: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  created_at: Date;
  decided_at: Date | null;
}

export interface SkillRunRow {
  id: string;
  skill_version_id: string;
  passed: boolean;
  score: string | null;
  evaluator: 'rules' | 'rules+model';
  verdict: string;
  created_at: Date;
}

export interface NewSkillVersion {
  description: string;
  content: string;
  files: { path: string; content: string }[];
  verdict: SkillVerdict;
  findings: SkillFindingView[];
  /** Only a reviewed bundled skill enters active. */
  state: 'staging' | 'active';
  sourceConversationId?: string | null;
  sourceRunId?: string | null;
  task?: string | null;
  derivedFrom?: readonly string[];
}

const AGENT = `a.id, a.name, a.avatar, a.role_title, a.template, a.current_version_id, a.archived_at, a.created_at, a.updated_at,
  (SELECT count(*)::int FROM agent_conversations c WHERE c.agent_id = a.id) AS conversations`;
const VERSION = `v.id, v.version, v.persona, v.instructions, v.model_tier, v.tools, v.memory_scope, v.autonomy,
  v.unattended_policy, v.budget_tokens, v.budget_sandbox_minutes, v.skills::text[] AS skills, v.note, v.created_at`;
const SKILL = `s.id, s.name, s.source, s.enabled, s.current_version_id, s.updated_at`;
const SKILL_VERSION = `v.id, v.skill_id, v.version, v.state::text AS state, v.description, v.content, v.files, v.scan_verdict,
  v.findings, v.source_conversation_id, v.source_run_id, v.task, v.derived_from, v.state_reason, v.approved_by,
  v.approved_at, v.created_at, v.decided_at`;

@Injectable()
export class StudioStore {
  constructor(private readonly scope: TenantScope) {}

  run<T>(owner: Owner, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.scope.run({ organizationId: owner.organizationId, memberId: owner.memberId }, fn);
  }

  // ───────────────────────────────────────────────────────────────── agents

  async agents(client: pg.PoolClient, includeArchived: boolean): Promise<AgentRow[]> {
    const { rows } = await client.query<AgentRow>(
      `SELECT ${AGENT} FROM agents a WHERE ($1 OR a.archived_at IS NULL) ORDER BY a.archived_at NULLS FIRST, a.created_at`,
      [includeArchived],
    );
    return rows;
  }

  async agent(client: pg.PoolClient, id: string, lock = false): Promise<AgentRow> {
    const { rows } = await client.query<AgentRow>(`SELECT ${AGENT} FROM agents a WHERE a.id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!rows[0]) throw AppError.notFound('Agent');
    return rows[0];
  }

  async countAgents(client: pg.PoolClient): Promise<number> {
    const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM agents WHERE archived_at IS NULL`);
    return rows[0]!.n;
  }

  /** A new agent and its first version, made current — in the caller's transaction. */
  async createAgent(
    client: pg.PoolClient,
    owner: Owner,
    identity: { name: string; avatar: string; roleTitle: string; template: string | null },
    definition: AgentDefinition,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO agents (organization_id, member_id, name, avatar, role_title, template)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [owner.organizationId, owner.memberId, identity.name, identity.avatar, identity.roleTitle, identity.template],
    );
    const id = rows[0]!.id;
    await this.addVersion(client, owner, id, definition, null);
    return id;
  }

  /** A new version, numbered by the database, and made the agent's current one. */
  async addVersion(client: pg.PoolClient, owner: Owner, agentId: string, d: AgentDefinition, note: string | null): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO agent_versions (organization_id, member_id, agent_id, version, persona, instructions, model_tier, tools,
                                   memory_scope, autonomy, unattended_policy, budget_tokens, budget_sandbox_minutes, skills, note)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [
        owner.organizationId,
        owner.memberId,
        agentId,
        d.persona,
        d.instructions,
        d.modelTier,
        d.tools,
        d.memoryScope,
        d.autonomy,
        d.unattendedPolicy,
        d.budgetTokens,
        d.budgetSandboxMinutes,
        d.skills,
        note,
      ],
    );
    await client.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [agentId, rows[0]!.id]);
    return rows[0]!.id;
  }

  async updateIdentity(
    client: pg.PoolClient,
    id: string,
    change: { name?: string | undefined; avatar?: string | undefined; roleTitle?: string | undefined },
  ): Promise<void> {
    await client.query(
      `UPDATE agents SET name = COALESCE($2, name), avatar = COALESCE($3, avatar), role_title = COALESCE($4, role_title)
        WHERE id = $1`,
      [id, change.name ?? null, change.avatar ?? null, change.roleTitle ?? null],
    );
  }

  async setArchived(client: pg.PoolClient, id: string, archived: boolean): Promise<void> {
    await client.query(
      `UPDATE agents SET archived_at = CASE WHEN $2 THEN COALESCE(archived_at, now()) ELSE NULL END WHERE id = $1`,
      [id, archived],
    );
  }

  async version(client: pg.PoolClient, id: string): Promise<AgentVersionRow> {
    const { rows } = await client.query<AgentVersionRow>(`SELECT ${VERSION} FROM agent_versions v WHERE v.id = $1`, [id]);
    if (!rows[0]) throw AppError.notFound('Agent version');
    return rows[0];
  }

  async versions(client: pg.PoolClient, agentId: string): Promise<AgentVersionRow[]> {
    const { rows } = await client.query<AgentVersionRow>(
      `SELECT ${VERSION} FROM agent_versions v WHERE v.agent_id = $1 ORDER BY v.version DESC LIMIT 200`,
      [agentId],
    );
    return rows;
  }

  // ───────────────────────────────────────────────────────────────── skills

  async skills(client: pg.PoolClient): Promise<SkillRow[]> {
    const { rows } = await client.query<SkillRow>(`SELECT ${SKILL} FROM skills s ORDER BY s.name LIMIT 500`);
    return rows;
  }

  async skill(client: pg.PoolClient, id: string, lock = false): Promise<SkillRow> {
    const { rows } = await client.query<SkillRow>(`SELECT ${SKILL} FROM skills s WHERE s.id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!rows[0]) throw AppError.notFound('Skill');
    return rows[0];
  }

  async skillByName(client: pg.PoolClient, name: string, lock = false): Promise<SkillRow | null> {
    const { rows } = await client.query<SkillRow>(`SELECT ${SKILL} FROM skills s WHERE s.name = $1${lock ? ' FOR UPDATE' : ''}`, [name]);
    return rows[0] ?? null;
  }

  /** Which of these ids are the person's skills. */
  async ownSkillIds(client: pg.PoolClient, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const { rows } = await client.query<{ id: string }>(`SELECT id FROM skills WHERE id::text = ANY ($1::text[])`, [ids]);
    return new Set(rows.map((r) => r.id));
  }

  async createSkill(client: pg.PoolClient, owner: Owner, name: string, source: SkillRow['source']): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO skills (organization_id, member_id, name, source) VALUES ($1, $2, $3, $4) RETURNING id`,
      [owner.organizationId, owner.memberId, name, source],
    );
    return rows[0]!.id;
  }

  async addSkillVersion(client: pg.PoolClient, owner: Owner, skillId: string, v: NewSkillVersion): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO skill_versions (organization_id, member_id, skill_id, version, state, description, content, files,
                                   scan_verdict, findings, source_conversation_id, source_run_id, task, derived_from)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        owner.organizationId,
        owner.memberId,
        skillId,
        v.state,
        v.description,
        v.content,
        JSON.stringify(v.files),
        v.verdict,
        JSON.stringify(v.findings),
        v.sourceConversationId ?? null,
        v.sourceRunId ?? null,
        v.task ?? null,
        v.derivedFrom ?? [],
      ],
    );
    return rows[0]!.id;
  }

  async skillVersion(client: pg.PoolClient, id: string, lock = false): Promise<SkillVersionRow> {
    const { rows } = await client.query<SkillVersionRow>(
      `SELECT ${SKILL_VERSION} FROM skill_versions v WHERE v.id = $1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    if (!rows[0]) throw AppError.notFound('Skill version');
    return rows[0];
  }

  async skillVersions(client: pg.PoolClient, skillIds: readonly string[]): Promise<SkillVersionRow[]> {
    if (skillIds.length === 0) return [];
    const { rows } = await client.query<SkillVersionRow>(
      `SELECT ${SKILL_VERSION} FROM skill_versions v WHERE v.skill_id::text = ANY ($1::text[]) ORDER BY v.version DESC`,
      [skillIds],
    );
    return rows;
  }

  async skillRuns(client: pg.PoolClient, versionIds: readonly string[]): Promise<SkillRunRow[]> {
    if (versionIds.length === 0) return [];
    const { rows } = await client.query<SkillRunRow>(
      `SELECT id, skill_version_id, passed, score::text AS score, evaluator, verdict, created_at
         FROM skill_runs WHERE skill_version_id::text = ANY ($1::text[]) ORDER BY created_at DESC`,
      [versionIds],
    );
    return rows;
  }

  /** A version's move; the database decides whether it may (0010, app.guard_skill_version). */
  async moveSkillVersion(
    client: pg.PoolClient,
    id: string,
    state: 'active' | 'rejected' | 'revoked' | 'superseded',
    change: { reason?: string | null; approvedBy?: string | null; approve?: boolean } = {},
  ): Promise<void> {
    await client.query(
      `UPDATE skill_versions
          SET state = $2::skill_state,
              state_reason = COALESCE($3, state_reason),
              approved_by = CASE WHEN $5 THEN $4 ELSE approved_by END,
              approved_at = CASE WHEN $5 THEN clock_timestamp() ELSE approved_at END
        WHERE id = $1`,
      [id, state, change.reason ?? null, change.approvedBy ?? null, change.approve ?? false],
    );
  }

  async setCurrentSkillVersion(client: pg.PoolClient, skillId: string, versionId: string): Promise<void> {
    await client.query(`UPDATE skills SET current_version_id = $2 WHERE id = $1`, [skillId, versionId]);
  }

  async setSkillEnabled(client: pg.PoolClient, skillId: string, enabled: boolean): Promise<void> {
    await client.query(`UPDATE skills SET enabled = $2 WHERE id = $1`, [skillId, enabled]);
  }

  async addSkillRun(
    client: pg.PoolClient,
    owner: Owner,
    versionId: string,
    run: { passed: boolean; score: number; evaluator: 'rules' | 'rules+model'; verdict: string; transcript: unknown },
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO skill_runs (organization_id, member_id, skill_version_id, passed, score, evaluator, verdict, transcript)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        owner.organizationId,
        owner.memberId,
        versionId,
        run.passed,
        Math.round(Math.max(0, Math.min(1, run.score)) * 1000) / 1000,
        run.evaluator,
        run.verdict.slice(0, 1000) || 'No verdict.',
        JSON.stringify(run.transcript),
      ],
    );
    return rows[0]!.id;
  }

  /** The person's message that started a run — the task a learned skill is replayed on. */
  async runTask(client: pg.PoolClient, runId: string): Promise<string | null> {
    const { rows } = await client.query<{ content: string }>(
      `SELECT content FROM agent_messages WHERE id = $1 AND role = 'user'`,
      [runId],
    );
    return rows[0]?.content ?? null;
  }
}

// ───────────────────────────────────────────────────────────────── views

export function versionView(row: AgentVersionRow): StudioAgentVersionView {
  return {
    id: row.id,
    version: row.version,
    persona: row.persona,
    instructions: row.instructions,
    modelTier: row.model_tier,
    tools: row.tools,
    memoryScope: row.memory_scope,
    autonomy: row.autonomy,
    unattendedPolicy: row.unattended_policy,
    budgetTokens: row.budget_tokens,
    budgetSandboxMinutes: row.budget_sandbox_minutes,
    skills: row.skills,
    note: row.note,
    createdAt: row.created_at.toISOString(),
  };
}

export function agentView(row: AgentRow, current: AgentVersionRow): StudioAgentView {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    roleTitle: row.role_title,
    template: row.template,
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    current: versionView(current),
    conversations: row.conversations,
  };
}

/** A version's definition, as a new version starts from it. */
export function definitionOf(row: AgentVersionRow): AgentDefinition {
  return {
    persona: row.persona,
    instructions: row.instructions,
    modelTier: row.model_tier,
    tools: row.tools,
    memoryScope: row.memory_scope,
    autonomy: row.autonomy,
    unattendedPolicy: row.unattended_policy,
    budgetTokens: row.budget_tokens,
    budgetSandboxMinutes: row.budget_sandbox_minutes,
    skills: row.skills,
  };
}

export function runView(row: SkillRunRow): SkillRunView {
  return {
    id: row.id,
    passed: row.passed,
    score: row.score === null ? null : Number(row.score),
    evaluator: row.evaluator,
    verdict: row.verdict,
    createdAt: row.created_at.toISOString(),
  };
}

export function skillVersionView(row: SkillVersionRow, runs: readonly SkillRunRow[]): SkillVersionView {
  return {
    id: row.id,
    version: row.version,
    state: row.state,
    description: row.description,
    content: row.content,
    files: row.files.map((f) => ({ path: f.path, chars: f.content.length })),
    scanVerdict: row.scan_verdict,
    findings: row.findings,
    sourceConversationId: row.source_conversation_id,
    task: row.task,
    derivedFrom: row.derived_from,
    stateReason: row.state_reason,
    approvedAt: row.approved_at?.toISOString() ?? null,
    approvedByPolicy: row.approved_at !== null && row.approved_by === null,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
    runs: runs.filter((r) => r.skill_version_id === row.id).map(runView),
  };
}

export function skillSummary(
  row: SkillRow,
  versions: readonly SkillVersionRow[],
  runs: readonly SkillRunRow[],
  title: { en: string; tr: string } | null,
): SkillSummaryView {
  const own = versions.filter((v) => v.skill_id === row.id);
  const active = own.find((v) => v.id === row.current_version_id && v.state === 'active') ?? null;
  const staging = own.find((v) => v.state === 'staging') ?? null;
  const stagingRuns = staging ? runs.filter((r) => r.skill_version_id === staging.id) : [];
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    enabled: row.enabled,
    active: active ? { id: active.id, version: active.version, description: active.description } : null,
    staging: staging
      ? {
          id: staging.id,
          version: staging.version,
          description: staging.description,
          replayed: stagingRuns.length > 0,
          passed: stagingRuns.length > 0 ? stagingRuns[0]!.passed : null,
        }
      : null,
    title,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function skillDetail(
  row: SkillRow,
  versions: readonly SkillVersionRow[],
  runs: readonly SkillRunRow[],
  title: { en: string; tr: string } | null,
): SkillDetailView {
  return {
    ...skillSummary(row, versions, runs, title),
    versions: versions.filter((v) => v.skill_id === row.id).map((v) => skillVersionView(v, runs)),
  };
}
