import { Inject, Injectable } from '@nestjs/common';
import {
  ErrorCode,
  type Principal,
  type RunStart,
  type RunSummaryView,
  type RunView,
  TEAM_LIMITS,
  type TeamCreate,
  type TeamMode,
  type TeamTemplateView,
  type TeamUpdate,
  type TeamView,
} from '@milyonuse/contracts';
import { TEAM_TEMPLATES, agentTemplate, teamTemplate } from '@milyonuse/skills';
import type pg from 'pg';
import { AppError } from '../../common/app-error.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { AgentStore } from '../agent/agent.store.js';
import { offeredModels } from '../agent/models.js';
import { modelFor } from '../agent/profile.js';
import { StudioService } from '../studio/studio.service.js';
import { AuditService } from '../tenancy/audit.service.js';
import { rethrowDatabaseError } from '../tenancy/database-error.js';
import { RunEngine } from './run-engine.js';
import { TeamsStore, memberView, runSummary, stepView, taskView, teamView } from './teams.store.js';

/**
 * Teams and their runs (F5): a roster of the person's own agents with a lead,
 * members and at most one reviewer; a run started on a goal is handed to the
 * engine in the queue and can be stopped, given more budget, or have a task
 * run again. A team made from a template gets agents of its own.
 */
@Injectable()
export class TeamsService {
  private readonly offered: string[];

  constructor(
    private readonly store: TeamsStore,
    private readonly agents: AgentStore,
    private readonly studio: StudioService,
    private readonly engine: RunEngine,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.offered = offeredModels(env);
  }

  // ─────────────────────────────────────────────────────────────── teams

  async list(principal: Principal, includeArchived: boolean): Promise<TeamView[]> {
    return this.store.run(principal, async (client) => {
      const rows = await this.store.teams(client, includeArchived);
      const members = await this.store.members(client, rows.map((r) => r.id));
      return rows.map((r) => teamView(r, members));
    });
  }

  async get(principal: Principal, id: string): Promise<TeamView> {
    return this.store.run(principal, (client) => this.viewIn(client, id));
  }

  templates(locale: 'en' | 'tr'): TeamTemplateView[] {
    return TEAM_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name[locale],
      purpose: t.purpose[locale],
      mode: t.mode,
      members: t.members.map((m) => {
        const base = agentTemplate(m.template)!;
        return {
          template: m.template,
          role: m.role,
          name: (m.name ?? base.name)[locale],
          roleTitle: (m.roleTitle ?? base.roleTitle)[locale],
          avatar: base.avatar,
          specialty: m.specialty[locale],
        };
      }),
    }));
  }

  async create(principal: Principal, input: TeamCreate): Promise<TeamView> {
    await this.store.run(principal, async (client) => {
      if ((await this.store.countTeams(client)) >= TEAM_LIMITS.teams) {
        throw new AppError(ErrorCode.CONFLICT, `You can keep up to ${TEAM_LIMITS.teams} teams. Archive one to make room.`);
      }
    });
    const template = input.template ? teamTemplate(input.template) : undefined;
    if (input.template && !template) throw AppError.notFound('Team template');

    // A template's agents are made for this team first: each from its agent template, named for its role here.
    let roster = input.members?.map((m, i) => ({ agentId: m.agentId, role: m.role, position: m.position ?? i, specialty: m.specialty ?? '' }));
    if (template && !roster) {
      roster = [];
      for (const [i, m] of template.members.entries()) {
        const agent = await this.studio.create(principal, {
          template: m.template,
          locale: input.locale,
          ...(m.name ? { name: m.name[input.locale] } : {}),
          ...(m.roleTitle ? { roleTitle: m.roleTitle[input.locale] } : {}),
        });
        roster.push({ agentId: agent.id, role: m.role, position: i, specialty: m.specialty[input.locale] });
      }
    }
    const id = await this.store.run(principal, async (client) => {
      await this.checkRoster(client, roster!.map((m) => m.agentId));
      try {
        const created = await this.store.createTeam(client, principal, {
          name: input.name ?? template?.name[input.locale] ?? 'My team',
          purpose: input.purpose ?? template?.purpose[input.locale] ?? '',
          mode: input.mode ?? template?.mode ?? 'hierarchical',
          budgetTokens: input.budgetTokens ?? 400_000,
          template: template?.id ?? null,
        });
        await this.store.setMembers(client, principal, created, roster!);
        await this.note(client, principal, 'team.created', created, { template: template?.id ?? null });
        return created;
      } catch (error) {
        rethrowDatabaseError(error);
      }
    });
    return this.get(principal, id);
  }

  async update(principal: Principal, id: string, input: TeamUpdate): Promise<TeamView> {
    return this.store.run(principal, async (client) => {
      const team = await this.store.team(client, id, true);
      if (team.archived_at) throw new AppError(ErrorCode.CONFLICT, 'Restore this team before changing it.');
      await this.store.updateTeam(client, id, input);
      if (input.members) {
        await this.checkRoster(client, input.members.map((m) => m.agentId));
        try {
          await this.store.setMembers(
            client,
            principal,
            id,
            input.members.map((m, i) => ({ agentId: m.agentId, role: m.role, position: m.position ?? i, specialty: m.specialty ?? '' })),
          );
        } catch (error) {
          rethrowDatabaseError(error);
        }
      }
      await this.note(client, principal, 'team.updated', id);
      return this.viewIn(client, id);
    });
  }

  async setArchived(principal: Principal, id: string, archived: boolean): Promise<TeamView> {
    return this.store.run(principal, async (client) => {
      await this.store.team(client, id, true);
      await this.store.setArchived(client, id, archived);
      await this.note(client, principal, archived ? 'team.archived' : 'team.restored', id);
      return this.viewIn(client, id);
    });
  }

  // ──────────────────────────────────────────────────────────────── runs

  async runs(
    principal: Principal,
    teamId?: string,
    filter: { automationId?: string | undefined; status?: string | undefined } = {},
  ): Promise<RunSummaryView[]> {
    return this.store.run(principal, async (client) => {
      if (teamId) await this.store.team(client, teamId);
      return (await this.store.runs(client, { teamId, ...filter }, 100)).map(runSummary);
    });
  }

  async getRun(principal: Principal, id: string): Promise<RunView> {
    return this.store.run(principal, (client) => this.runIn(client, id));
  }

  /** A run on a goal: its conversation with the lead, its first slice queued. An automation's run carries its automation and policy. */
  async start(
    principal: Principal,
    teamId: string,
    input: RunStart,
    from: { automationId: string; policy: 'safe_only' | 'trusted'; title: string } | null = null,
  ): Promise<RunView> {
    const id = await this.store.run(principal, async (client) => {
      const team = await this.store.team(client, teamId);
      if (team.archived_at) throw new AppError(ErrorCode.CONFLICT, 'Restore this team before giving it work.');
      const members = (await this.store.members(client, [teamId])).filter((m) => !m.archived);
      const lead = members.find((m) => m.role === 'lead');
      if (!lead) throw new AppError(ErrorCode.CONFLICT, 'The team needs a lead whose agent is not archived.');
      if (team.mode === 'debate' && members.filter((m) => m.role === 'member').length < 2) {
        throw new AppError(ErrorCode.CONFLICT, 'A debate needs at least two members.');
      }
      const profile = await this.agents.agentProfile(client, lead.agent_id);
      const conversation = await this.agents.createConversation(client, principal, {
        title: (from?.title ?? `${team.name}: ${input.goal.replace(/\s+/g, ' ').slice(0, 80)}`).slice(0, 120),
        model: modelFor(this.offered, profile.modelTier, this.env.AGENT_MODEL),
        agentId: lead.agent_id,
        teamId,
      });
      await this.agents.addMessage(client, principal, conversation.id, { role: 'user', content: input.goal });
      try {
        const runId = await this.store.createRun(client, principal, {
          teamId,
          conversationId: conversation.id,
          goal: input.goal,
          mode: team.mode as TeamMode,
          budgetTokens: input.budgetTokens ?? team.budget_tokens,
          automationId: from?.automationId ?? null,
          policy: from?.policy ?? null,
        });
        await this.store.step(client, principal, runId, {
          kind: 'note',
          summary: from ? `Started by the automation “${from.title.slice(0, 120)}”` : `Started on “${input.goal.slice(0, 200)}”`,
        });
        await this.engine.queue(client, principal, runId);
        await this.note(client, principal, 'team.run_started', teamId, { runId });
        return runId;
      } catch (error) {
        rethrowDatabaseError(error);
      }
    });
    this.engine.kick();
    return this.getRun(principal, id);
  }

  /** Stops it: open tasks are cancelled, what was done is kept. */
  async cancel(principal: Principal, id: string): Promise<RunView> {
    return this.store.run(principal, async (client) => {
      const run = await this.store.getRun(client, id, true);
      if (run.status === 'completed' || run.status === 'cancelled') throw new AppError(ErrorCode.CONFLICT, 'This run has already finished.');
      await this.store.cancelOpenTasks(client, id);
      await this.store.step(client, principal, id, { kind: 'note', summary: 'Stopped by you' });
      await this.store.setRunStatus(client, id, 'cancelled');
      return this.runIn(client, id);
    });
  }

  /** Goes on after waiting for budget, with more of it. */
  async resume(principal: Principal, id: string, addTokens: number): Promise<RunView> {
    const view = await this.store.run(principal, async (client) => {
      const run = await this.store.getRun(client, id, true);
      if (run.status !== 'waiting_approval') throw new AppError(ErrorCode.CONFLICT, 'Only a run waiting for you can be resumed.');
      try {
        await this.store.setRunStatus(client, id, 'running', { addBudget: addTokens, error: null });
      } catch (error) {
        rethrowDatabaseError(error);
      }
      await this.store.step(client, principal, id, { kind: 'budget', summary: `You added ${addTokens.toLocaleString('en-US')} tokens; going on` });
      await this.engine.queue(client, principal, id);
      return this.runIn(client, id);
    });
    this.engine.kick();
    return view;
  }

  /** A failed or interrupted task, run again as a new attempt — and the run goes on if it had stopped for it. */
  async rerunTask(principal: Principal, runId: string, taskId: string): Promise<RunView> {
    const view = await this.store.run(principal, async (client) => {
      const run = await this.store.getRun(client, runId, true);
      if (run.status === 'completed' || run.status === 'cancelled') throw new AppError(ErrorCode.CONFLICT, 'This run has finished.');
      const task = (await this.store.tasks(client, runId)).find((t) => t.id === taskId);
      if (!task) throw AppError.notFound('Task');
      if (!['failed', 'uncertain', 'cancelled'].includes(task.status)) {
        throw new AppError(ErrorCode.CONFLICT, 'Only a task that failed, was interrupted or was cancelled is run again.');
      }
      try {
        await this.store.retryTask(client, taskId, null);
        if (run.status === 'failed') await this.store.setRunStatus(client, runId, 'running', { error: null });
      } catch (error) {
        rethrowDatabaseError(error);
      }
      await this.store.step(client, principal, runId, { kind: 'note', taskId, summary: `You ran ${task.key} again` });
      await this.engine.queue(client, principal, runId);
      return this.runIn(client, runId);
    });
    this.engine.kick();
    return view;
  }

  // ─────────────────────────────────────────────────────────────── helpers

  private async viewIn(client: pg.PoolClient, id: string): Promise<TeamView> {
    const team = await this.store.team(client, id);
    return teamView(team, await this.store.members(client, [id]));
  }

  private async runIn(client: pg.PoolClient, id: string): Promise<RunView> {
    const run = await this.store.getRun(client, id);
    const tasks = await this.store.tasks(client, id);
    const steps = await this.store.steps(client, id);
    const members = run.team_id ? await this.store.members(client, [run.team_id]) : [];
    return {
      ...runSummary(run),
      result: run.result,
      error: run.error,
      revisions: run.revisions,
      tasks: tasks.map(taskView),
      steps: steps.map((s) => stepView(s, tasks)),
      members: members.map(memberView),
      proposals: await this.store.proposals(client, run.conversation_id),
    };
  }

  /** The person's own agents, none archived. */
  private async checkRoster(client: pg.PoolClient, agentIds: readonly string[]): Promise<void> {
    const { rows } = await client.query<{ id: string; archived: boolean }>(
      `SELECT id, archived_at IS NOT NULL AS archived FROM agents WHERE id::text = ANY ($1::text[])`,
      [agentIds],
    );
    if (rows.length !== new Set(agentIds).size) throw new AppError(ErrorCode.VALIDATION_FAILED, 'A team is made of your own agents.');
    if (rows.some((r) => r.archived)) throw new AppError(ErrorCode.VALIDATION_FAILED, 'An archived agent cannot join a team.');
  }

  private note(client: pg.PoolClient, principal: Principal, action: string, teamId: string, after?: Record<string, unknown>): Promise<void> {
    return this.audit.record(client, {
      organizationId: principal.organizationId,
      actorMemberId: principal.memberId,
      action,
      resourceType: 'team',
      resourceId: teamId,
      after,
    });
  }
}
