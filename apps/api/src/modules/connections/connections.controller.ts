import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import {
  type ConnectionAppView,
  type ConnectionStartResult,
  type ConnectionView,
  type Principal,
  connectionCallbackSchema,
  connectionStartSchema,
  connectionUpdateSchema,
  ulidSchema,
} from '@milyonuse/contracts';
import type { FastifyReply } from 'fastify';
import { AppError } from '../../common/app-error.js';
import { RateLimit } from '../../common/rate-limit.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { Inject } from '@nestjs/common';
import { SessionGuard } from '../identity/session.guard.js';
import { PermissionGuard, RequirePermission } from '../tenancy/guards/permission.guard.js';
import { CurrentPrincipal } from '../tenancy/guards/principal.decorator.js';
import { PrincipalGuard } from '../tenancy/guards/principal.guard.js';
import { IdempotencyExempt } from '../tenancy/idempotency.js';
import { ConnectionsService } from './connections.service.js';

/** A person's connected apps (the Connections page). One person's own; another's are "not found". */
@Controller('connections')
@UseGuards(SessionGuard, PrincipalGuard, PermissionGuard)
@RequirePermission('agents.use')
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('apps')
  apps(): { items: ConnectionAppView[] } {
    return { items: this.connections.apps() };
  }

  @Get()
  async list(@CurrentPrincipal() principal: Principal): Promise<{ items: ConnectionView[] }> {
    return { items: await this.connections.list(principal) };
  }

  /** Starts connecting: answers the app's consent page to go to, or the connection when a token was given. */
  @Post()
  @HttpCode(200)
  @IdempotencyExempt('Carries a token, and answers a single-use authorization — neither may be stored for replay.')
  @RateLimit({ limit: 20, windowSec: 600, per: 'member' })
  async start(@CurrentPrincipal() principal: Principal, @Body() body: unknown): Promise<ConnectionStartResult> {
    return this.connections.start(principal, connectionStartSchema.parse(body));
  }

  /** Where the app sends the person back: the code becomes a connection, and the browser goes to the page. */
  @Get('callback')
  @RateLimit({ limit: 30, windowSec: 600, per: 'member' })
  async callback(@CurrentPrincipal() principal: Principal, @Query() query: unknown, @Res() reply: FastifyReply): Promise<void> {
    const page = `${this.env.APP_BASE_URL.replace(/\/$/, '')}/app/connections`;
    try {
      const connection = await this.connections.callback(principal, connectionCallbackSchema.parse(query));
      await reply.redirect(`${page}?connected=${connection.id}`, 303);
    } catch (error) {
      const message = error instanceof AppError ? error.message : 'Connecting did not finish. Try again.';
      await reply.redirect(`${page}?error=${encodeURIComponent(message.slice(0, 200))}`, 303);
    }
  }

  @Get(':connectionId')
  async get(@CurrentPrincipal() principal: Principal, @Param('connectionId') id: string): Promise<ConnectionView> {
    return this.connections.get(principal, ulidSchema.parse(id));
  }

  @Patch(':connectionId')
  async update(@CurrentPrincipal() principal: Principal, @Param('connectionId') id: string, @Body() body: unknown): Promise<ConnectionView> {
    return this.connections.update(principal, ulidSchema.parse(id), connectionUpdateSchema.parse(body));
  }

  /** Lists the app's tools again — after it changed, or to clear an error. */
  @Post(':connectionId/refresh')
  @HttpCode(200)
  @IdempotencyExempt('Listing again changes nothing but the list.')
  @RateLimit({ limit: 20, windowSec: 600, per: 'member' })
  async refresh(@CurrentPrincipal() principal: Principal, @Param('connectionId') id: string): Promise<ConnectionView> {
    return this.connections.refreshTools(principal, ulidSchema.parse(id));
  }

  /** Disconnects: its secrets are gone at once, and a proposal that needs it fails at confirm. */
  @Delete(':connectionId')
  @HttpCode(204)
  async revoke(@CurrentPrincipal() principal: Principal, @Param('connectionId') id: string): Promise<void> {
    await this.connections.revoke(principal, ulidSchema.parse(id));
  }
}
