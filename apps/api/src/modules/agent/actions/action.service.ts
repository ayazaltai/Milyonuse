import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  type AgentActionListQuery,
  type AgentActionPreview,
  type AgentActionView,
  ErrorCode,
  type Principal,
  can,
} from '@milyonuse/contracts';
import { type RiskVerdict, classify, redact, redactDeep } from '@milyonuse/security';
import type pg from 'pg';
import { AppError } from '../../../common/app-error.js';
import { AppLogger } from '../../../common/logging/logger.js';
import { secretBoxFor } from '../../../common/secret-box.js';
import { ENV } from '../../../config/config.module.js';
import type { Env } from '../../../config/env.js';
import { PLATFORM_POOL } from '../../../database/database.module.js';
import { type ClaimedJob, JobRegistry, type JobOutcome, PermanentJobError, enqueue } from '../../queue/job.js';
import { rethrowDatabaseError } from '../../tenancy/database-error.js';
import { AuditService } from '../../tenancy/audit.service.js';
import { TenantScope } from '../../tenancy/tenant-scope.service.js';
import { AgentToolbox, type ToolSet } from '../agent.toolbox.js';
import type { AgentTool, ToolContext } from '../tools/tool.js';
import { type ActionRow, ActionStore, actionView } from './action.store.js';

/** Items run inside the request that confirmed them; more go on in the queue. */
const INLINE_ITEMS = 20;
/** Items one queued slice runs. */
const SLICE = 25;
/** What of a result the action keeps, and the model rereads. */
const RESULT_CHARS = 20_000;
/** A run that has not finished in this long died with its process. */
const STALE_RUN_MS = 15 * 60_000;

export const ACTION_JOB = 'agent_action';

export interface ProposeContext extends ToolContext {
  messageId?: string | null | undefined;
  toolCallId?: string | null | undefined;
}

/**
 * The one write path (rule 3, D-11): a tool call that is not safe becomes an
 * action. The RiskEngine says whether it runs as it is made — recorded,
 * auto-confirmed, still undoable — or waits on a card for the person.
 *
 * Confirming re-checks everything as it is *now*: the person may still use the
 * agent, the tool still exists for them (a connection removed in between fails
 * the action), its arguments still parse, and the RiskEngine does not block
 * it. It then runs as that person — once. A large action runs in slices, the
 * first in the request and the rest in the durable queue; an item a crash
 * interrupted is uncertain, reported and never run twice. An undo is a new
 * proposal: the inverse call the tool names, confirmed like any other.
 */
@Injectable()
export class ActionService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: ActionStore,
    private readonly toolbox: AgentToolbox,
    private readonly scope: TenantScope,
    private readonly audit: AuditService,
    private readonly jobs: JobRegistry,
    @Inject(PLATFORM_POOL) private readonly platform: pg.Pool,
    @Inject(ENV) private readonly env: Env,
    private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    this.jobs.register(ACTION_JOB, { handle: (job) => this.handleSlice(job) });
  }

  /** The hourly sweep, where no scheduler calls the cron route (WORKER_MODE=interval). */
  onApplicationBootstrap(): void {
    if (this.env.NODE_ENV === 'test' || this.env.WORKER_MODE === 'cron') return;
    this.timer = setInterval(() => {
      this.sweep().catch((error: unknown) =>
        this.logger.error('agent action sweep failed', { err: error instanceof Error ? error.message : String(error) }),
      );
    }, 60 * 60_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private run<T>(principal: Pick<Principal, 'organizationId' | 'memberId'>, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.scope.run({ organizationId: principal.organizationId, memberId: principal.memberId }, fn);
  }

  /** The RiskEngine's word on a call, in this mode — and, for work no one watches (a team run), under its policy. */
  classify(
    tool: AgentTool,
    args: Record<string, unknown>,
    mode: ToolContext['mode'],
    unattended?: { policy: 'safe_only' | 'trusted' },
  ): RiskVerdict {
    return classify({
      tool: { name: tool.name, risk: tool.risk ?? 'safe', reversible: tool.reversible ?? true },
      args,
      mode: mode ?? 'ask',
      ...(unattended ? { unattended } : {}),
    });
  }

  // ──────────────────────────────────────────────────────────────── propose

  /**
   * Records an action for a call the RiskEngine did not let run on its own —
   * or, when it did (`auto`), records it and runs it at once.
   */
  async propose(
    principal: Principal,
    context: ProposeContext,
    tool: AgentTool,
    args: Record<string, unknown>,
    verdict: RiskVerdict,
    options: { undoOf?: string | undefined } = {},
  ): Promise<AgentActionView> {
    const preview = redactDeep(tool.preview ? await tool.preview(context, args) : genericPreview(tool, args));
    if (verdict.findings.length > 0) {
      preview.warnings = [...(preview.warnings ?? []), ...verdict.findings.map((f) => `The code: ${f.detail}`)];
    }
    const items = tool.items?.(args) ?? null;
    if (items && (items.length === 0 || items.length > 10_000)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'An action takes between 1 and 10,000 items.');
    }
    const auto = verdict.decision === 'auto' && !options.undoOf;
    const row = await this.run(principal, async (client) => {
      try {
        const created = await this.store.insert(client, principal, {
          conversationId: context.conversationId,
          messageId: context.messageId ?? null,
          toolCallId: context.toolCallId ?? null,
          tool: tool.name,
          connectionId: tool.connectionId ?? null,
          args,
          preview,
          risk: verdict.risk,
          reversible: verdict.reversible,
          reason: verdict.reason,
          itemCount: items?.length ?? 1,
          autoConfirmed: auto,
          undoOf: options.undoOf ?? null,
        });
        if (items) await this.store.addItems(client, principal, created.id, items);
        await this.audit.record(client, {
          organizationId: principal.organizationId,
          actorMemberId: principal.memberId,
          actorType: 'agent',
          action: auto ? 'agent.action_auto' : 'agent.action_proposed',
          resourceType: 'agent_action',
          resourceId: created.id,
          after: { tool: tool.name, risk: verdict.risk, reversible: verdict.reversible, undoOf: options.undoOf ?? null },
        });
        return created;
      } catch (error) {
        rethrowDatabaseError(error);
      }
    });
    if (auto) return this.confirm(principal, row.id, { auto: true, timeZone: context.timeZone });
    return this.view(row);
  }

  // ──────────────────────────────────────────────────────────────── confirm

  async confirm(principal: Principal, id: string, options: { auto?: boolean; timeZone?: string } = {}): Promise<AgentActionView> {
    if (!can(principal, 'agents.use')) throw AppError.permissionDenied('You may not use the agent in this organization.');
    const set = await this.toolbox.forPrincipal(principal);
    const prepared = await this.run(principal, async (client) => {
      const row = await this.store.get(client, id, { lock: true });
      if (row.status !== 'proposed') {
        throw new AppError(ErrorCode.CONFLICT, `This action is already ${row.status}.`);
      }
      if (row.expires_at.getTime() <= Date.now()) {
        throw new AppError(ErrorCode.CONFLICT, 'This proposal expired. Ask the agent again.');
      }
      // Everything is checked as it is now, not as it was when proposed.
      const problem = this.recheck(set, row);
      try {
        await this.store.start(client, id);
        await this.audit.record(client, {
          organizationId: principal.organizationId,
          actorMemberId: principal.memberId,
          actorType: options.auto ? 'agent' : 'member',
          action: 'agent.action_confirmed',
          resourceType: 'agent_action',
          resourceId: id,
          after: { tool: row.tool, auto: Boolean(options.auto) },
        });
        if (problem.kind === 'refused') {
          await this.store.finish(client, id, { status: 'failed', error: problem.message });
          return null;
        }
      } catch (error) {
        rethrowDatabaseError(error);
      }
      return { row, tool: problem.tool, args: problem.args };
    });
    if (!prepared) return this.get(principal, id);

    const context: ToolContext = {
      principal,
      conversationId: prepared.row.conversation_id,
      runId: id,
      actionId: id,
      timeZone: options.timeZone ?? 'UTC',
      mode: 'ask',
    };
    if (prepared.tool.items && prepared.tool.runItem) {
      await this.runSlice(principal, prepared.row, prepared.tool, prepared.args, context, INLINE_ITEMS);
      return this.get(principal, id);
    }
    await this.runWhole(principal, prepared.row, prepared.tool, prepared.args, context);
    return this.get(principal, id);
  }

  /** The tool as the person has it now, the arguments as they parse now, and the RiskEngine's word now. */
  private recheck(
    set: ToolSet,
    row: ActionRow,
  ): { kind: 'ready'; tool: AgentTool; args: Record<string, unknown> } | { kind: 'refused'; message: string } {
    const tool = set.get(row.tool);
    if (!tool || (tool.connectionId && tool.connectionId !== row.connection_id) || (row.connection_id && !tool.connectionId)) {
      return {
        kind: 'refused',
        message: row.connection_name
          ? `${row.connection_name} is no longer connected, so this was not done.`
          : 'This tool is no longer available to you, so this was not done.',
      };
    }
    const prepared = set.prepare(row.tool, row.args);
    if (prepared.kind === 'error') return { kind: 'refused', message: prepared.message };
    const verdict = this.classify(tool, prepared.args, 'ask');
    if (verdict.decision === 'block') return { kind: 'refused', message: `Blocked: ${verdict.reason}.` };
    return { kind: 'ready', tool, args: prepared.args };
  }

  private async runWhole(principal: Principal, row: ActionRow, tool: AgentTool, args: Record<string, unknown>, context: ToolContext): Promise<void> {
    await this.run(principal, (client) => this.store.progress(client, row.id, { claimedThrough: 1, processed: 0, succeeded: 0, failed: 0, uncertain: 0 }));
    const outcome = await this.toolbox.execute(tool, args, context);
    await this.run(principal, async (client) => {
      if (outcome.kind === 'error') {
        await this.store.progress(client, row.id, { claimedThrough: 1, processed: 1, succeeded: 0, failed: 1, uncertain: 0 });
        await this.store.finish(client, row.id, { status: 'failed', error: redact(outcome.message) });
      } else {
        await this.store.progress(client, row.id, { claimedThrough: 1, processed: 1, succeeded: 1, failed: 0, uncertain: 0 });
        await this.store.finish(client, row.id, { status: 'completed', result: keepResult(outcome.data) });
      }
      await this.audit.record(client, {
        organizationId: principal.organizationId,
        actorMemberId: principal.memberId,
        actorType: 'agent',
        action: outcome.kind === 'error' ? 'agent.action_failed' : 'agent.action_completed',
        resourceType: 'agent_action',
        resourceId: row.id,
        after: { tool: row.tool },
      });
    });
  }

  /**
   * Runs up to `limit` of an action's items: each claimed (running) before it
   * runs and settled after, so a crash between the two leaves it uncertain.
   * What is left goes on in the queue; the last slice finishes the action.
   */
  private async runSlice(
    principal: Principal,
    row: ActionRow,
    tool: AgentTool,
    args: Record<string, unknown>,
    context: ToolContext,
    limit: number,
  ): Promise<void> {
    const claimed = await this.run(principal, async (client) => {
      const items = await this.store.claim(client, row.id, limit);
      const counts = await this.store.itemCounts(client, row.id);
      await this.store.progress(client, row.id, this.tally(row.item_count, counts));
      return items;
    });
    for (const item of claimed) {
      let outcome: { status: 'succeeded' | 'failed'; result?: unknown; error?: string };
      try {
        outcome = { status: 'succeeded', result: keepResult(await tool.runItem!(context, args, item.input)) };
      } catch (error) {
        outcome = { status: 'failed', error: redact(error instanceof Error ? error.message : String(error)) };
      }
      await this.run(principal, (client) => this.store.settleItem(client, row.id, item.seq, outcome));
    }
    await this.run(principal, async (client) => {
      const counts = await this.store.itemCounts(client, row.id);
      await this.store.progress(client, row.id, this.tally(row.item_count, counts));
      if (counts.pending === 0 && counts.running === 0) {
        const done = counts.succeeded + counts.failed + counts.uncertain;
        await this.store.finish(client, row.id, {
          status: counts.succeeded > 0 || done === 0 ? 'completed' : 'failed',
          result: { succeeded: counts.succeeded, failed: counts.failed, uncertain: counts.uncertain },
          error: counts.failed + counts.uncertain > 0 ? `${counts.failed} failed, ${counts.uncertain} uncertain` : null,
        });
        await this.audit.record(client, {
          organizationId: principal.organizationId,
          actorMemberId: principal.memberId,
          actorType: 'agent',
          action: 'agent.action_completed',
          resourceType: 'agent_action',
          resourceId: row.id,
          after: { tool: row.tool, ...counts },
        });
      } else {
        await enqueue(client, {
          organizationId: principal.organizationId,
          kind: ACTION_JOB,
          payload: { actionId: row.id, memberId: principal.memberId },
          dedupeKey: `agent_action:${row.id}:${counts.succeeded + counts.failed + counts.uncertain}`,
          maxAttempts: 3,
        });
      }
    });
  }

  private tally(itemCount: number, counts: Record<'pending' | 'running' | 'succeeded' | 'failed' | 'uncertain', number>) {
    const processed = counts.succeeded + counts.failed + counts.uncertain;
    return {
      claimedThrough: Math.min(itemCount, processed + counts.running),
      processed,
      succeeded: counts.succeeded,
      failed: counts.failed,
      uncertain: counts.uncertain,
    };
  }

  /** A queued slice: the person is read again — still a member, still allowed — before anything runs. */
  private async handleSlice(job: ClaimedJob): Promise<JobOutcome> {
    const actionId = String(job.payload['actionId'] ?? '');
    const memberId = String(job.payload['memberId'] ?? '');
    const principal = await this.principalOf(job.organizationId, memberId);
    if (!principal) throw new PermanentJobError('The person who confirmed this action can no longer act.');
    const row = await this.run(principal, (client) => this.store.get(client, actionId));
    if (row.status !== 'running') return { status: 'skipped', reason: `action is ${row.status}` };
    const set = await this.toolbox.forPrincipal(principal);
    const problem = this.recheck(set, row);
    if (problem.kind === 'refused') {
      await this.run(principal, async (client) => {
        await this.store.abandonRunning(client, row.id);
        await this.store.finish(client, row.id, { status: 'failed', error: problem.message });
      });
      return { status: 'succeeded' };
    }
    await this.runSlice(
      principal,
      row,
      problem.tool,
      problem.args,
      { principal, conversationId: row.conversation_id, runId: row.id, actionId: row.id, timeZone: 'UTC', mode: 'ask' },
      SLICE,
    );
    return { status: 'succeeded' };
  }

  private async principalOf(organizationId: string, memberId: string): Promise<Principal | null> {
    // PLATFORM_POOL: a queued job knows only the ids it was given; the member is read before a tenant scope exists.
    const { rows } = await this.platform.query<{ user_id: string; role: Principal['role']; kind: Principal['organizationKind'] }>(
      `SELECT m.user_id, m.role, o.kind
         FROM members m JOIN organizations o ON o.id = m.organization_id
        WHERE m.id = $1 AND m.organization_id = $2 AND m.status = 'active' AND o.status = 'active'`,
      [memberId, organizationId],
    );
    const r = rows[0];
    if (!r) return null;
    const principal: Principal = { userId: r.user_id, organizationId, organizationKind: r.kind, memberId, role: r.role };
    return can(principal, 'agents.use') ? principal : null;
  }

  // ───────────────────────────────────────────────────────── discard, undo

  async discard(principal: Principal, id: string): Promise<AgentActionView> {
    return this.run(principal, async (client) => {
      const row = await this.store.get(client, id, { lock: true });
      if (row.status !== 'proposed') throw new AppError(ErrorCode.CONFLICT, `This action is already ${row.status}.`);
      try {
        await this.store.discard(client, id);
        await this.audit.record(client, {
          organizationId: principal.organizationId,
          actorMemberId: principal.memberId,
          action: 'agent.action_discarded',
          resourceType: 'agent_action',
          resourceId: id,
        });
      } catch (error) {
        rethrowDatabaseError(error);
      }
      return this.view(await this.store.get(client, id));
    });
  }

  /** An undo is a new proposal — the tool's inverse of what was done — that the person confirms. */
  async undo(principal: Principal, id: string, timeZone = 'UTC'): Promise<AgentActionView> {
    const set = await this.toolbox.forPrincipal(principal);
    const row = await this.run(principal, (client) => this.store.get(client, id));
    if (row.status !== 'completed') throw new AppError(ErrorCode.CONFLICT, 'Only a completed action can be undone.');
    if (row.undone) throw new AppError(ErrorCode.CONFLICT, 'An undo of this action was already proposed.');
    const tool = set.get(row.tool);
    const inverse = tool?.inverse?.(row.args, row.result?.['data'] ?? row.result);
    if (!tool || !inverse) throw new AppError(ErrorCode.CONFLICT, 'This action cannot be undone.');
    const prepared = set.prepare(inverse.tool, inverse.args);
    if (prepared.kind === 'error') throw new AppError(ErrorCode.CONFLICT, `This action cannot be undone: ${prepared.message}`);
    const verdict = this.classify(prepared.tool, prepared.args, 'ask');
    if (verdict.decision === 'block') throw new AppError(ErrorCode.CONFLICT, `This action cannot be undone: ${verdict.reason}.`);
    // An undo always waits for the person, whatever the RiskEngine would allow.
    const asked: RiskVerdict = { ...verdict, decision: 'proposal', reason: `Undo of an earlier action — ${verdict.reason}` };
    return this.propose(
      principal,
      { principal, conversationId: row.conversation_id, runId: row.id, timeZone, mode: 'ask' },
      prepared.tool,
      prepared.args,
      asked,
      { undoOf: row.id },
    );
  }

  // ────────────────────────────────────────────────────────────────── read

  async get(principal: Principal, id: string): Promise<AgentActionView> {
    return this.run(principal, async (client) => this.view(await this.store.get(client, id)));
  }

  async list(principal: Principal, query: AgentActionListQuery): Promise<AgentActionView[]> {
    return this.run(principal, async (client) =>
      (await this.store.list(client, { conversationId: query.conversationId, status: query.status })).map((r) => this.view(r)),
    );
  }

  /** A conversation's actions, oldest first — its cards. */
  async forConversation(client: pg.PoolClient, conversationId: string): Promise<AgentActionView[]> {
    return (await this.store.list(client, { conversationId }, 200)).reverse().map((r) => this.view(r));
  }

  /** What the agent should know of its actions in this conversation, for the next turn's context. */
  async recentFor(principal: Principal, conversationId: string): Promise<AgentActionView[]> {
    return this.run(principal, async (client) =>
      (await this.store.list(client, { conversationId, since: new Date(Date.now() - 7 * 86_400_000) }, 20)).map((r) => this.view(r)),
    );
  }

  private view(row: ActionRow): AgentActionView {
    return actionView(row, (r) => {
      const tool = this.toolbox.tools.find((t) => t.name === r.tool);
      // A connected app's tool is known only per person; its card says it can be undone when the tool said so at proposal.
      return tool ? Boolean(tool.inverse) : r.tool.startsWith('calendar_');
    });
  }

  // ──────────────────────────────────────────────────────── the hourly pass

  /**
   * Proposals nobody answered expire; runs whose process died are closed —
   * their unfinished items uncertain, never run again.
   */
  async sweep(): Promise<{ expired: number; interrupted: number }> {
    // PLATFORM_POOL: the pass looks across organizations for what is past its time; each fix runs in the owner's scope.
    const expired = await this.platform.query(
      `UPDATE agent_actions SET status = 'expired' WHERE status = 'proposed' AND expires_at <= now()`,
    );
    const { rows: stale } = await this.platform.query<{ id: string; organization_id: string; member_id: string }>(
      `SELECT a.id, a.organization_id, c.member_id
         FROM agent_actions a JOIN agent_conversations c ON c.id = a.conversation_id
        WHERE a.status = 'running' AND a.updated_at < now() - make_interval(secs => $1::double precision / 1000)
          AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.organization_id = a.organization_id
                           AND j.kind = 'agent_action' AND j.status IN ('queued', 'running')
                           AND j.payload->>'actionId' = a.id::text)
        LIMIT 200`,
      [STALE_RUN_MS],
    );
    let interrupted = 0;
    for (const s of stale) {
      try {
        await this.run({ organizationId: s.organization_id, memberId: s.member_id }, async (client) => {
          const row = await this.store.get(client, s.id, { lock: true });
          if (row.status !== 'running') return;
          await this.store.abandonRunning(client, s.id);
          const counts = await this.store.itemCounts(client, s.id);
          const hasItems = Object.values(counts).some((n) => n > 0);
          await this.store.progress(
            client,
            s.id,
            hasItems
              ? this.tally(row.item_count, counts)
              : { claimedThrough: 1, processed: 1, succeeded: 0, failed: 0, uncertain: 1 },
          );
          await this.store.finish(client, s.id, {
            status: 'failed',
            error: 'Interrupted before it was known to finish. What was not confirmed done is marked uncertain and was not run again.',
          });
        });
        interrupted += 1;
      } catch (error) {
        this.logger.warn('agent action sweep skipped one', { actionId: s.id, err: error instanceof Error ? error.message : String(error) });
      }
    }
    return { expired: expired.rowCount ?? 0, interrupted };
  }

  // ─────────────────────────────────────────────────────────── provenance

  /**
   * A header that ties a call made on a person's behalf to the action that
   * made it: `<action id>.<HMAC>` — an app that keeps an audit log can record
   * which confirmed action reached it, and nobody can forge one.
   */
  provenance(actionId: string): string {
    return `${actionId}.${secretBoxFor(this.env).sign('action-provenance', actionId)}`;
  }
}

/** A card for a tool that drew none: its arguments, labelled, nothing hidden. */
export function genericPreview(tool: AgentTool, args: Record<string, unknown>): AgentActionPreview {
  return {
    title: tool.summary,
    fields: Object.entries(args)
      .slice(0, 20)
      .map(([key, value]) => ({
        label: key,
        value: (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 500),
      })),
  };
}

/** A result as an action keeps it: redacted, bounded, an object. */
export function keepResult(data: unknown): Record<string, unknown> {
  const clean = redactDeep(data);
  const text = JSON.stringify(clean ?? null);
  if (text.length <= RESULT_CHARS) return { data: clean as unknown };
  return { data: `${text.slice(0, RESULT_CHARS)}…`, truncated: true };
}
