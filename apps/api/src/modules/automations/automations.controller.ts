import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import {
  type AutomationDetailView,
  type AutomationDraftView,
  type AutomationTriggerView,
  type AutomationView,
  type InboxCount,
  type InboxItemView,
  type InboxView,
  type Principal,
  automationCreateSchema,
  automationDraftSchema,
  automationRunSchema,
  automationUpdateSchema,
  inboxBulkSchema,
  ulidSchema,
} from '@milyonuse/contracts';
import { z } from 'zod';
import { RateLimit } from '../../common/rate-limit.js';
import type { RawBodyRequest } from '../../common/raw-body.js';
import { SessionGuard } from '../identity/session.guard.js';
import { PermissionGuard, RequirePermission } from '../tenancy/guards/permission.guard.js';
import { CurrentPrincipal } from '../tenancy/guards/principal.decorator.js';
import { PrincipalGuard } from '../tenancy/guards/principal.guard.js';
import { IdempotencyExempt, Idempotent } from '../tenancy/idempotency.js';
import { AutomationsService } from './automations.service.js';
import { type HookAnswer, HookIntake } from './hook-intake.js';
import { InboxService } from './inbox.service.js';

const readSchema = z.object({ ids: z.union([z.literal('all'), z.array(ulidSchema).min(1).max(100)]) });

/** A person's automations. Another person's is a 404 — the policies name the member (0013). */
@Controller('automations')
@UseGuards(SessionGuard, PrincipalGuard, PermissionGuard)
@RequirePermission('agents.use')
export class AutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  @Get()
  async list(@CurrentPrincipal() principal: Principal): Promise<{ items: AutomationView[] }> {
    return { items: await this.automations.list(principal) };
  }

  /** Words to a configuration to look over — nothing is made. */
  @Post('draft')
  @HttpCode(200)
  @IdempotencyExempt('A draft is computed from the words and stored nowhere.')
  draft(@Body() body: unknown): AutomationDraftView {
    return this.automations.draft(automationDraftSchema.parse(body ?? {}).text);
  }

  @Post()
  @Idempotent()
  async create(@CurrentPrincipal() principal: Principal, @Body() body: unknown): Promise<AutomationView> {
    return this.automations.create(principal, automationCreateSchema.parse(body ?? {}));
  }

  @Get(':id')
  async get(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<AutomationDetailView> {
    return this.automations.get(principal, ulidSchema.parse(id));
  }

  @Patch(':id')
  async update(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown): Promise<AutomationView> {
    return this.automations.update(principal, ulidSchema.parse(id), automationUpdateSchema.parse(body ?? {}));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<void> {
    await this.automations.remove(principal, ulidSchema.parse(id));
  }

  @Post(':id/rotate-hook')
  @HttpCode(200)
  @IdempotencyExempt('It answers a new secret; a stored answer would show a secret again.')
  async rotate(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<AutomationView> {
    return this.automations.rotateHook(principal, ulidSchema.parse(id));
  }

  @Post(':id/run')
  @HttpCode(200)
  @Idempotent()
  @RateLimit({ limit: 10, windowSec: 60, per: 'member' })
  async run(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown): Promise<{ trigger: AutomationTriggerView }> {
    return this.automations.runNow(principal, ulidSchema.parse(id), automationRunSchema.parse(body ?? {}).input, false);
  }

  /** Runs it once as it would run — even turned off, outside its daily cap. */
  @Post(':id/test')
  @HttpCode(200)
  @Idempotent()
  @RateLimit({ limit: 10, windowSec: 60, per: 'member' })
  async test(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown): Promise<{ trigger: AutomationTriggerView }> {
    return this.automations.runNow(principal, ulidSchema.parse(id), automationRunSchema.parse(body ?? {}).input, true);
  }
}

/** Everything waiting for the person's word. */
@Controller('inbox')
@UseGuards(SessionGuard, PrincipalGuard, PermissionGuard)
@RequirePermission('agents.use')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  async view(@CurrentPrincipal() principal: Principal): Promise<InboxView> {
    return this.inbox.view(principal);
  }

  @Get('count')
  async count(@CurrentPrincipal() principal: Principal): Promise<InboxCount> {
    return this.inbox.count(principal);
  }

  @Post('read')
  @HttpCode(200)
  @IdempotencyExempt('Marking read sets a state; doing it twice leaves the same state.')
  async read(@CurrentPrincipal() principal: Principal, @Body() body: unknown): Promise<{ updated: number }> {
    return { updated: await this.inbox.markRead(principal, readSchema.parse(body ?? {}).ids) };
  }

  @Post('items/:id/resolve')
  @HttpCode(200)
  @IdempotencyExempt('Resolving sets a state; doing it twice leaves the same state.')
  async resolve(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<InboxItemView> {
    return this.inbox.resolve(principal, ulidSchema.parse(id));
  }

  /** Confirms several proposals; each is checked as it is now and answers for itself. */
  @Post('proposals/confirm')
  @HttpCode(200)
  @IdempotencyExempt('A proposal runs at most once — in SQL (0009); a repeat finds it answered.')
  async confirm(@CurrentPrincipal() principal: Principal, @Body() body: unknown): Promise<{ results: { id: string; status: string | null; error: string | null }[] }> {
    const input = inboxBulkSchema.parse(body ?? {});
    return this.inbox.bulk(principal, 'confirm', input.ids, input.timeZone);
  }

  @Post('proposals/discard')
  @HttpCode(200)
  @IdempotencyExempt('A discarded proposal stays discarded; a repeat finds it answered.')
  async discard(@CurrentPrincipal() principal: Principal, @Body() body: unknown): Promise<{ results: { id: string; status: string | null; error: string | null }[] }> {
    return this.inbox.bulk(principal, 'discard', inboxBulkSchema.parse(body ?? {}).ids);
  }
}

/**
 * Events from outside. Public, because a sender has no session: a webhook is
 * authenticated by its signature, forwarded mail by the provider's bearer.
 */
@Controller('hooks')
export class HooksController {
  constructor(private readonly intake: HookIntake) {}

  @Post('inbound-mail')
  @HttpCode(202)
  @RateLimit({ limit: 300, windowSec: 60, per: 'address' })
  async mail(@Headers('authorization') authorization: string | undefined, @Body() body: unknown): Promise<HookAnswer> {
    return this.intake.mail(authorization, body);
  }

  @Post(':token')
  @HttpCode(202)
  @RateLimit({ limit: 120, windowSec: 60, per: 'address' })
  async webhook(
    @Param('token') token: string,
    @Req() request: RawBodyRequest,
    @Headers('x-milyonuse-signature') signature: string | undefined,
    @Headers('x-milyonuse-timestamp') timestamp: string | undefined,
    @Headers('x-milyonuse-delivery') delivery: string | undefined,
  ): Promise<HookAnswer> {
    return this.intake.webhook(z.string().regex(/^[a-z0-9]{24,48}$/).parse(token), request.rawBody ?? '', { signature, timestamp, delivery });
  }
}
