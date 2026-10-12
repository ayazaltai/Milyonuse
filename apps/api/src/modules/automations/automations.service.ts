import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  type AutomationCreate,
  type AutomationDetailView,
  type AutomationDraftView,
  type AutomationTriggerView,
  type AutomationUpdate,
  type AutomationView,
  ErrorCode,
  type Principal,
} from '@milyonuse/contracts';
import type pg from 'pg';
import { AppError } from '../../common/app-error.js';
import { secretBoxFor } from '../../common/secret-box.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { AgentStore } from '../agent/agent.store.js';
import { rethrowDatabaseError } from '../tenancy/database-error.js';
import { TeamsStore, runSummary } from '../teams/teams.store.js';
import { type AutomationColumns, type AutomationRow, AutomationsStore, type TriggerRow } from './automations.store.js';
import { draftFrom } from './draft.js';
import { AutomationLauncher } from './launcher.js';

/** The purpose a hook's signing key is derived for — the key itself is never stored. */
export const HOOK_PURPOSE = 'automation-hook';

/**
 * A person's automations (F6): made, changed, turned on and off, run now or
 * tested, and read with what started them and what they ran. What an
 * automation may be is the database's rule (0013); this arranges the work and
 * keeps two promises the database cannot see: `trusted` only after the person
 * confirmed it, and a hook's signing secret shown when it is made, not stored.
 */
@Injectable()
export class AutomationsService {
  constructor(
    private readonly store: AutomationsStore,
    private readonly teams: TeamsStore,
    private readonly agents: AgentStore,
    private readonly launcher: AutomationLauncher,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async list(principal: Principal): Promise<AutomationView[]> {
    return this.store.run(principal, async (client) => (await this.store.list(client)).map((row) => this.view(row)));
  }

  async get(principal: Principal, id: string): Promise<AutomationDetailView> {
    return this.store.run(principal, (client) => this.detail(client, id));
  }

  draft(text: string, today = new Date()): AutomationDraftView {
    return draftFrom(text, today);
  }

  async create(principal: Principal, input: AutomationCreate): Promise<AutomationView> {
    const hooked = input.kind === 'webhook' || input.kind === 'email';
    const token = hooked ? newToken() : null;
    const id = await this.store.run(principal, async (client) => {
      await this.checkTargets(client, input);
      const columns: AutomationColumns = {
        ...this.columns(input, null),
        kind: input.kind,
        name: input.name,
        prompt: input.prompt,
        hook_token: token,
      };
      try {
        return await this.store.create(client, principal, columns);
      } catch (error) {
        rethrowDatabaseError(error);
      }
    });
    const view = await this.store.run(principal, async (client) => this.view(await this.store.get(client, id)));
    return token ? this.withSecret(view, token) : view;
  }

  async update(principal: Principal, id: string, input: AutomationUpdate): Promise<AutomationView> {
    return this.store.run(principal, async (client) => {
      const current = await this.store.get(client, id, true);
      await this.checkTargets(client, input);
      try {
        await this.store.update(client, id, this.columns(input, current));
      } catch (error) {
        rethrowDatabaseError(error);
      }
      return this.view(await this.store.get(client, id));
    });
  }

  async remove(principal: Principal, id: string): Promise<void> {
    const removed = await this.store.run(principal, (client) => this.store.remove(client, id));
    if (!removed) throw AppError.notFound('Automation');
  }

  /** A new address and secret for a webhook or mail automation; the old ones stop working at once. */
  async rotateHook(principal: Principal, id: string): Promise<AutomationView> {
    const token = newToken();
    const view = await this.store.run(principal, async (client) => {
      const current = await this.store.get(client, id, true);
      if (current.kind !== 'webhook' && current.kind !== 'email') {
        throw new AppError(ErrorCode.CONFLICT, 'Only a webhook or mail automation has an address.');
      }
      await this.store.update(client, id, { hook_token: token });
      return this.view(await this.store.get(client, id));
    });
    return this.withSecret(view, token);
  }

  /**
   * Runs it now, as if its event had come: `test` also runs a turned-off
   * automation and does not count against its daily cap.
   */
  async runNow(principal: Principal, id: string, input: string | undefined, test: boolean): Promise<{ trigger: AutomationTriggerView }> {
    const trigger = await this.store.run(principal, async (client) => {
      const automation = await this.store.get(client, id);
      if (!test && !automation.enabled) throw new AppError(ErrorCode.CONFLICT, 'Turn it on first, or test it.');
      return this.launcher.accept(client, principal, automation, {
        source: test ? 'test' : 'manual',
        dedupeKey: `${test ? 'test' : 'manual'}:${randomBytes(9).toString('hex')}`,
        payload: input ? { input } : {},
      });
    });
    if (!trigger) throw new AppError(ErrorCode.CONFLICT, 'That run was already asked for.');
    await this.launcher.fire(principal, trigger.id);
    return this.store.run(principal, async (client) => ({ trigger: triggerView(await this.store.trigger(client, trigger.id)) }));
  }

  // ─────────────────────────────────────────────────────────────── views

  private async detail(client: pg.PoolClient, id: string): Promise<AutomationDetailView> {
    const row = await this.store.get(client, id);
    const [triggers, runs, monitor] = await Promise.all([
      this.store.triggers(client, id),
      this.teams.runs(client, { automationId: id }, 30),
      row.kind === 'monitor' ? this.store.monitor(client, id) : Promise.resolve(null),
    ]);
    return {
      ...this.view(row),
      triggers: triggers.map(triggerView),
      runs: runs.map(runSummary),
      monitor:
        row.kind === 'monitor'
          ? {
              lastCheckedAt: monitor?.last_checked_at?.toISOString() ?? null,
              lastChangedAt: monitor?.last_changed_at?.toISOString() ?? null,
              checks: monitor?.checks ?? 0,
              changes: monitor?.changes ?? 0,
              excerpt: monitor?.last_excerpt?.slice(0, 600) ?? null,
            }
          : null,
    };
  }

  view(row: AutomationRow): AutomationView {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      enabled: row.enabled,
      target: row.target_team_id ? { agentId: null, teamId: row.target_team_id } : { agentId: row.target_agent_id!, teamId: null },
      targetName: row.target_name,
      prompt: row.prompt,
      policy: row.policy,
      trustedConfirmedAt: row.trusted_confirmed_at?.toISOString() ?? null,
      timeZone: row.time_zone,
      quietHours: row.quiet_start && row.quiet_end ? { start: row.quiet_start, end: row.quiet_end } : null,
      budgetTokens: row.budget_tokens,
      dailyCap: row.daily_cap,
      failurePolicy: row.failure_policy,
      notify: row.notify,
      cadence: row.cadence,
      weekdays: row.weekdays,
      monthDay: row.month_day,
      localTime: row.local_time,
      everyHours: row.every_hours,
      nextRunAt: row.enabled ? (row.next_run_at?.toISOString() ?? null) : null,
      monitorUrl: row.monitor_url,
      monitorCondition: row.monitor_condition,
      goalUntil: row.goal_until,
      hook: row.hook_token ? this.hook(row.hook_token) : null,
      watchAutomationId: row.watch_automation_id,
      watchTeamId: row.watch_team_id,
      watchEvents: row.watch_events,
      consecutiveFailures: row.consecutive_failures,
      pausedReason: row.paused_reason,
      lastRunAt: row.last_run_at?.toISOString() ?? null,
      lastOutcome: row.last_outcome,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private hook(token: string): { url: string; email: string } {
    return { url: `${this.env.APP_BASE_URL}/api/v1/hooks/${token}`, email: `${token}@${this.env.INBOUND_MAIL_DOMAIN}` };
  }

  private withSecret(view: AutomationView, token: string): AutomationView {
    return { ...view, hook: { ...this.hook(token), secret: hookSecret(this.env, token) } };
  }

  // ──────────────────────────────────────────────────────────── columns

  /** What the person said, as columns; `trusted` only with its confirmation, unless it already was. */
  private columns(input: AutomationUpdate, current: AutomationRow | null): AutomationColumns {
    const c: AutomationColumns = {};
    if (input.name !== undefined) c.name = input.name;
    if (input.enabled !== undefined) c.enabled = input.enabled;
    if (input.target !== undefined) {
      c.target_agent_id = 'agentId' in input.target ? input.target.agentId : null;
      c.target_team_id = 'teamId' in input.target ? input.target.teamId : null;
    }
    if (input.prompt !== undefined) c.prompt = input.prompt;
    if (input.policy === 'trusted' && current?.policy !== 'trusted') {
      if (!input.confirmTrusted) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Running reversible work with no one watching needs your confirmation.', {
          details: [{ path: 'confirmTrusted', message: 'Confirm that you read what trusted means.' }],
        });
      }
      c.policy = 'trusted';
      c.trusted_confirmed_at = new Date();
    } else if (input.policy === 'safe_only') {
      c.policy = 'safe_only';
      c.trusted_confirmed_at = null;
    }
    if (input.timeZone !== undefined) c.time_zone = input.timeZone;
    if (input.quietHours !== undefined) {
      c.quiet_start = input.quietHours?.start ?? null;
      c.quiet_end = input.quietHours?.end ?? null;
    }
    if (input.budgetTokens !== undefined) c.budget_tokens = input.budgetTokens;
    if (input.dailyCap !== undefined) c.daily_cap = input.dailyCap;
    if (input.failurePolicy !== undefined) c.failure_policy = input.failurePolicy;
    if (input.notify !== undefined) c.notify = [...new Set(input.notify)];
    if (input.cadence !== undefined) c.cadence = input.cadence;
    if (input.weekdays !== undefined) c.weekdays = [...new Set(input.weekdays)].sort();
    if (input.monthDay !== undefined) c.month_day = input.monthDay;
    if (input.localTime !== undefined) c.local_time = input.localTime;
    if (input.everyHours !== undefined) c.every_hours = input.everyHours;
    if (input.monitorUrl !== undefined) c.monitor_url = input.monitorUrl;
    if (input.monitorCondition !== undefined) c.monitor_condition = input.monitorCondition;
    if (input.goalUntil !== undefined) c.goal_until = input.goalUntil;
    if (input.watchAutomationId !== undefined) c.watch_automation_id = input.watchAutomationId;
    if (input.watchTeamId !== undefined) c.watch_team_id = input.watchTeamId;
    if (input.watchEvents !== undefined) c.watch_events = [...new Set(input.watchEvents)];
    return c;
  }

  /** What it runs and watches is the person's own — another's is a 404, like everywhere else. */
  private async checkTargets(client: pg.PoolClient, input: AutomationUpdate): Promise<void> {
    if (input.target && 'agentId' in input.target) {
      const profile = await this.agents.agentProfile(client, input.target.agentId);
      if (profile.archived) throw new AppError(ErrorCode.CONFLICT, 'That agent is archived. Restore it first.');
    }
    if (input.target && 'teamId' in input.target) {
      const team = await this.teams.team(client, input.target.teamId);
      if (team.archived_at) throw new AppError(ErrorCode.CONFLICT, 'That team is archived. Restore it first.');
    }
    if (input.watchTeamId) await this.teams.team(client, input.watchTeamId);
    if (input.watchAutomationId) await this.store.get(client, input.watchAutomationId);
  }
}

/** A hook's address: 48 characters nobody guesses. */
function newToken(): string {
  return randomBytes(24).toString('hex');
}

/** A hook's signing secret, derived from its token by the server's key — the same every time, stored nowhere. */
export function hookSecret(env: Env, token: string): string {
  return `whsec_${secretBoxFor(env).sign(HOOK_PURPOSE, token)}`;
}

export function triggerView(row: TriggerRow): AutomationTriggerView {
  return { id: row.id, source: row.source, status: row.status, reason: row.reason, runId: row.run_id, createdAt: row.created_at.toISOString() };
}
