import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  type Principal,
  type StudioAgentVersionView,
  type StudioAgentView,
  type StudioTemplateView,
  type StudioToolOption,
  studioAgentCreateSchema,
  studioAgentUpdateSchema,
  ulidSchema,
} from '@milyonuse/contracts';
import { z } from 'zod';
import { SessionGuard } from '../identity/session.guard.js';
import { PermissionGuard, RequirePermission } from '../tenancy/guards/permission.guard.js';
import { CurrentPrincipal } from '../tenancy/guards/principal.decorator.js';
import { PrincipalGuard } from '../tenancy/guards/principal.guard.js';
import { IdempotencyExempt, Idempotent } from '../tenancy/idempotency.js';
import { StudioService } from './studio.service.js';

const listQuery = z.object({ archived: z.enum(['true', 'false']).optional() });
const localeQuery = z.object({ locale: z.enum(['en', 'tr']).default('en') });

/**
 * The studio: a person's own agents. Another person's agent is a 404 —
 * the policies name the member (0010).
 */
@Controller('agents')
@UseGuards(SessionGuard, PrincipalGuard, PermissionGuard)
@RequirePermission('agents.use')
export class StudioController {
  constructor(private readonly studio: StudioService) {}

  @Get()
  async list(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<{ items: StudioAgentView[] }> {
    const { archived } = listQuery.parse(query ?? {});
    return { items: await this.studio.list(principal, archived === 'true') };
  }

  /** The gallery's starting points, in the person's language. */
  @Get('templates')
  templates(@Query() query: unknown): { items: StudioTemplateView[] } {
    return { items: this.studio.templates(localeQuery.parse(query ?? {}).locale) };
  }

  /** What an agent may be allowed beyond the core tools every agent has. */
  @Get('tools')
  tools(): { items: StudioToolOption[] } {
    return { items: this.studio.toolOptions() };
  }

  @Post()
  @Idempotent()
  async create(@CurrentPrincipal() principal: Principal, @Body() body: unknown): Promise<StudioAgentView> {
    return this.studio.create(principal, studioAgentCreateSchema.parse(body ?? {}));
  }

  @Get(':agentId')
  async get(@CurrentPrincipal() principal: Principal, @Param('agentId') agentId: string): Promise<StudioAgentView> {
    return this.studio.get(principal, ulidSchema.parse(agentId));
  }

  /** Name, face and role title in place; a definition change is a new version. */
  @Patch(':agentId')
  async update(@CurrentPrincipal() principal: Principal, @Param('agentId') agentId: string, @Body() body: unknown): Promise<StudioAgentView> {
    return this.studio.update(principal, ulidSchema.parse(agentId), studioAgentUpdateSchema.parse(body ?? {}));
  }

  @Get(':agentId/versions')
  async versions(@CurrentPrincipal() principal: Principal, @Param('agentId') agentId: string): Promise<{ items: StudioAgentVersionView[] }> {
    return { items: await this.studio.versions(principal, ulidSchema.parse(agentId)) };
  }

  @Post(':agentId/archive')
  @HttpCode(200)
  @IdempotencyExempt('Archiving sets a state; doing it twice leaves the same state.')
  async archive(@CurrentPrincipal() principal: Principal, @Param('agentId') agentId: string): Promise<StudioAgentView> {
    return this.studio.setArchived(principal, ulidSchema.parse(agentId), true);
  }

  @Post(':agentId/restore')
  @HttpCode(200)
  @IdempotencyExempt('Restoring sets a state; doing it twice leaves the same state.')
  async restore(@CurrentPrincipal() principal: Principal, @Param('agentId') agentId: string): Promise<StudioAgentView> {
    return this.studio.setArchived(principal, ulidSchema.parse(agentId), false);
  }
}
