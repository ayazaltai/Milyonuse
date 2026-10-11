import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  type Principal,
  type SkillCatalogueEntry,
  type SkillDetailView,
  type SkillSummaryView,
  skillBundledSchema,
  skillDecisionSchema,
  skillUpdateSchema,
  skillWriteSchema,
  ulidSchema,
} from '@milyonuse/contracts';
import { RateLimit } from '../../common/rate-limit.js';
import { SessionGuard } from '../identity/session.guard.js';
import { PermissionGuard, RequirePermission } from '../tenancy/guards/permission.guard.js';
import { CurrentPrincipal } from '../tenancy/guards/principal.decorator.js';
import { PrincipalGuard } from '../tenancy/guards/principal.guard.js';
import { IdempotencyExempt, Idempotent } from '../tenancy/idempotency.js';
import { SkillsService } from './skills.service.js';

/**
 * A person's skills: the catalogue, what they write, what their agents
 * learned, and their word on each staged version. Nothing here makes a
 * version active without a passing replay — the database refuses it (0010).
 */
@Controller('skills')
@UseGuards(SessionGuard, PrincipalGuard, PermissionGuard)
@RequirePermission('agents.use')
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  async list(@CurrentPrincipal() principal: Principal): Promise<{ items: SkillSummaryView[] }> {
    return { items: await this.skills.list(principal) };
  }

  /** The reviewed bundled skills, and which the person already has. */
  @Get('catalogue')
  async catalogue(@CurrentPrincipal() principal: Principal): Promise<{ items: SkillCatalogueEntry[] }> {
    return { items: await this.skills.catalogue(principal) };
  }

  @Post('bundled')
  @Idempotent()
  async addBundled(@CurrentPrincipal() principal: Principal, @Body() body: unknown): Promise<SkillDetailView> {
    return this.skills.addBundled(principal, skillBundledSchema.parse(body ?? {}).name);
  }

  /** A SKILL.md the person wrote — a new skill, or a new version of theirs by the same name. Replayed before use. */
  @Post()
  @Idempotent()
  @RateLimit({ limit: 20, windowSec: 60, per: 'member' })
  async write(@CurrentPrincipal() principal: Principal, @Body() body: unknown): Promise<SkillDetailView> {
    return this.skills.write(principal, skillWriteSchema.parse(body ?? {}));
  }

  @Get(':skillId')
  async get(@CurrentPrincipal() principal: Principal, @Param('skillId') skillId: string): Promise<SkillDetailView> {
    return this.skills.detail(principal, ulidSchema.parse(skillId));
  }

  @Patch(':skillId')
  async update(@CurrentPrincipal() principal: Principal, @Param('skillId') skillId: string, @Body() body: unknown): Promise<SkillDetailView> {
    return this.skills.setEnabled(principal, ulidSchema.parse(skillId), skillUpdateSchema.parse(body ?? {}).enabled);
  }

  @Post('versions/:versionId/approve')
  @HttpCode(200)
  @IdempotencyExempt('A version is approved once; the database refuses a second move from staging.')
  async approve(@CurrentPrincipal() principal: Principal, @Param('versionId') versionId: string): Promise<SkillDetailView> {
    return this.skills.approve(principal, ulidSchema.parse(versionId));
  }

  @Post('versions/:versionId/reject')
  @HttpCode(200)
  @IdempotencyExempt('A version is rejected once; the database refuses a second move from staging.')
  async reject(@CurrentPrincipal() principal: Principal, @Param('versionId') versionId: string, @Body() body: unknown): Promise<SkillDetailView> {
    return this.skills.reject(principal, ulidSchema.parse(versionId), skillDecisionSchema.parse(body ?? {}).reason);
  }

  @Post('versions/:versionId/replay')
  @HttpCode(202)
  @IdempotencyExempt('A replay is queued once per attempt number; a repeat queues nothing new.')
  @RateLimit({ limit: 10, windowSec: 60, per: 'member' })
  async replay(@CurrentPrincipal() principal: Principal, @Param('versionId') versionId: string): Promise<SkillDetailView> {
    return this.skills.replayAgain(principal, ulidSchema.parse(versionId));
  }
}
