import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { type AgentActionView, type Principal, agentActionListQuerySchema, ulidSchema } from '@milyonuse/contracts';
import { z } from 'zod';
import { RateLimit } from '../../../common/rate-limit.js';
import { SessionGuard } from '../../identity/session.guard.js';
import { PermissionGuard, RequirePermission } from '../../tenancy/guards/permission.guard.js';
import { CurrentPrincipal } from '../../tenancy/guards/principal.decorator.js';
import { PrincipalGuard } from '../../tenancy/guards/principal.guard.js';
import { IdempotencyExempt } from '../../tenancy/idempotency.js';
import { ActionService } from './action.service.js';

const timeZoneBody = z.object({ timeZone: z.string().min(1).max(64).optional() }).default({});

/**
 * The cards: what the agent proposed or did, and the person's word on each —
 * confirm, discard, undo. One person's own actions only; another's are
 * "not found".
 */
@Controller('agent/actions')
@UseGuards(SessionGuard, PrincipalGuard, PermissionGuard)
@RequirePermission('agents.use')
export class ActionController {
  constructor(private readonly actions: ActionService) {}

  @Get()
  async list(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<{ items: AgentActionView[] }> {
    return { items: await this.actions.list(principal, agentActionListQuerySchema.parse(query ?? {})) };
  }

  @Get(':actionId')
  async get(@CurrentPrincipal() principal: Principal, @Param('actionId') actionId: string): Promise<AgentActionView> {
    return this.actions.get(principal, ulidSchema.parse(actionId));
  }

  /** Runs it, as the person, once — everything re-checked as it is now. */
  @Post(':actionId/confirm')
  @HttpCode(200)
  @IdempotencyExempt('A proposal runs at most once by the database; a second confirm is refused, not repeated.')
  @RateLimit({ limit: 30, windowSec: 60, per: 'member' })
  async confirm(
    @CurrentPrincipal() principal: Principal,
    @Param('actionId') actionId: string,
    @Body() body: unknown,
  ): Promise<AgentActionView> {
    const { timeZone } = timeZoneBody.parse(body ?? {});
    return this.actions.confirm(principal, ulidSchema.parse(actionId), timeZone ? { timeZone } : {});
  }

  @Post(':actionId/discard')
  @HttpCode(200)
  @IdempotencyExempt('Discarding a discarded proposal is refused by the database, not repeated.')
  async discard(@CurrentPrincipal() principal: Principal, @Param('actionId') actionId: string): Promise<AgentActionView> {
    return this.actions.discard(principal, ulidSchema.parse(actionId));
  }

  /** Proposes the inverse of a completed action — a new card, confirmed like any other. */
  @Post(':actionId/undo')
  @HttpCode(201)
  @IdempotencyExempt('One undo per action: a second is refused while the first stands.')
  @RateLimit({ limit: 30, windowSec: 60, per: 'member' })
  async undo(
    @CurrentPrincipal() principal: Principal,
    @Param('actionId') actionId: string,
    @Body() body: unknown,
  ): Promise<AgentActionView> {
    return this.actions.undo(principal, ulidSchema.parse(actionId), timeZoneBody.parse(body ?? {}).timeZone);
  }
}
