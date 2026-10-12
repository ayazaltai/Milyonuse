import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  type Principal,
  type RunSummaryView,
  type RunView,
  type TeamTemplateView,
  type TeamView,
  runResumeSchema,
  runStartSchema,
  teamCreateSchema,
  teamUpdateSchema,
  ulidSchema,
} from '@milyonuse/contracts';
import { z } from 'zod';
import { RateLimit } from '../../common/rate-limit.js';
import { SessionGuard } from '../identity/session.guard.js';
import { PermissionGuard, RequirePermission } from '../tenancy/guards/permission.guard.js';
import { CurrentPrincipal } from '../tenancy/guards/principal.decorator.js';
import { PrincipalGuard } from '../tenancy/guards/principal.guard.js';
import { IdempotencyExempt, Idempotent } from '../tenancy/idempotency.js';
import { TeamsService } from './teams.service.js';

const listQuery = z.object({ archived: z.enum(['true', 'false']).optional() });
const localeQuery = z.object({ locale: z.enum(['en', 'tr']).default('en') });

/** A person's teams. Another person's team is a 404 — the policies name the member (0012). */
@Controller('teams')
@UseGuards(SessionGuard, PrincipalGuard, PermissionGuard)
@RequirePermission('agents.use')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  async list(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<{ items: TeamView[] }> {
    return { items: await this.teams.list(principal, listQuery.parse(query ?? {}).archived === 'true') };
  }

  @Get('templates')
  templates(@Query() query: unknown): { items: TeamTemplateView[] } {
    return { items: this.teams.templates(localeQuery.parse(query ?? {}).locale) };
  }

  @Post()
  @Idempotent()
  async create(@CurrentPrincipal() principal: Principal, @Body() body: unknown): Promise<TeamView> {
    return this.teams.create(principal, teamCreateSchema.parse(body ?? {}));
  }

  @Get(':teamId')
  async get(@CurrentPrincipal() principal: Principal, @Param('teamId') teamId: string): Promise<TeamView> {
    return this.teams.get(principal, ulidSchema.parse(teamId));
  }

  @Patch(':teamId')
  async update(@CurrentPrincipal() principal: Principal, @Param('teamId') teamId: string, @Body() body: unknown): Promise<TeamView> {
    return this.teams.update(principal, ulidSchema.parse(teamId), teamUpdateSchema.parse(body ?? {}));
  }

  @Post(':teamId/archive')
  @HttpCode(200)
  @IdempotencyExempt('Archiving sets a state; doing it twice leaves the same state.')
  async archive(@CurrentPrincipal() principal: Principal, @Param('teamId') teamId: string): Promise<TeamView> {
    return this.teams.setArchived(principal, ulidSchema.parse(teamId), true);
  }

  @Post(':teamId/restore')
  @HttpCode(200)
  @IdempotencyExempt('Restoring sets a state; doing it twice leaves the same state.')
  async restore(@CurrentPrincipal() principal: Principal, @Param('teamId') teamId: string): Promise<TeamView> {
    return this.teams.setArchived(principal, ulidSchema.parse(teamId), false);
  }

  @Get(':teamId/runs')
  async runs(@CurrentPrincipal() principal: Principal, @Param('teamId') teamId: string): Promise<{ items: RunSummaryView[] }> {
    return { items: await this.teams.runs(principal, ulidSchema.parse(teamId)) };
  }

  /** Gives the team a goal: a run, advanced by the queue. */
  @Post(':teamId/runs')
  @Idempotent()
  @RateLimit({ limit: 10, windowSec: 60, per: 'member' })
  async start(@CurrentPrincipal() principal: Principal, @Param('teamId') teamId: string, @Body() body: unknown): Promise<RunView> {
    return this.teams.start(principal, ulidSchema.parse(teamId), runStartSchema.parse(body ?? {}));
  }
}

/** Runs: their graph, steps and result, and the person's word — stop, more budget, run a task again. */
@Controller('runs')
@UseGuards(SessionGuard, PrincipalGuard, PermissionGuard)
@RequirePermission('agents.use')
export class RunsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  async list(@CurrentPrincipal() principal: Principal): Promise<{ items: RunSummaryView[] }> {
    return { items: await this.teams.runs(principal) };
  }

  @Get(':runId')
  async get(@CurrentPrincipal() principal: Principal, @Param('runId') runId: string): Promise<RunView> {
    return this.teams.getRun(principal, ulidSchema.parse(runId));
  }

  @Post(':runId/cancel')
  @HttpCode(200)
  @IdempotencyExempt('A finished run is refused, not stopped twice.')
  async cancel(@CurrentPrincipal() principal: Principal, @Param('runId') runId: string): Promise<RunView> {
    return this.teams.cancel(principal, ulidSchema.parse(runId));
  }

  @Post(':runId/resume')
  @HttpCode(200)
  @IdempotencyExempt('Only a run waiting for the person resumes; a repeat is refused, so budget is never added twice.')
  async resume(@CurrentPrincipal() principal: Principal, @Param('runId') runId: string, @Body() body: unknown): Promise<RunView> {
    return this.teams.resume(principal, ulidSchema.parse(runId), runResumeSchema.parse(body ?? {}).addTokens);
  }

  @Post(':runId/tasks/:taskId/rerun')
  @HttpCode(200)
  @IdempotencyExempt('Only a failed, interrupted or cancelled task is run again; a repeat finds it waiting and is refused.')
  async rerun(@CurrentPrincipal() principal: Principal, @Param('runId') runId: string, @Param('taskId') taskId: string): Promise<RunView> {
    return this.teams.rerunTask(principal, ulidSchema.parse(runId), ulidSchema.parse(taskId));
  }
}
