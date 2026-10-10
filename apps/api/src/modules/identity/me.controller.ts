import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import {
  type Me,
  type Principal,
  type SessionSummary,
  changePasswordInputSchema,
  ulidSchema,
  updateProfileSchema,
} from '@milyonuse/contracts';
import { AppError } from '../../common/app-error.js';
import { RateLimit } from '../../common/rate-limit.js';
import { CurrentPrincipal, type RequestWithPrincipal } from '../tenancy/guards/principal.decorator.js';
import { PrincipalGuard } from '../tenancy/guards/principal.guard.js';
import { Idempotent, IdempotencyExempt } from '../tenancy/idempotency.js';
import { AccountService } from './account.service.js';
import { ProfileService } from './profile.service.js';
import { contextOf } from './request-context.js';
import { SessionGuard } from './session.guard.js';
import { SessionService } from './session.service.js';

/**
 * The signed-in person's own account: profile, password and sessions. A
 * person's own record, so no permission beyond being signed in; every change
 * is in their organization's audit log.
 */
@Controller('me')
@UseGuards(SessionGuard, PrincipalGuard)
export class MeController {
  constructor(
    private readonly profiles: ProfileService,
    private readonly accounts: AccountService,
    private readonly sessions: SessionService,
  ) {}

  @Get()
  async me(@CurrentPrincipal() principal: Principal): Promise<Me> {
    return this.profiles.me(principal);
  }

  @Patch()
  @Idempotent()
  async update(@CurrentPrincipal() principal: Principal, @Body() body: unknown): Promise<Me> {
    return this.profiles.update(principal, updateProfileSchema.parse(body));
  }

  /** Changes the password; every other session ends, this one stays. */
  @Post('password')
  @HttpCode(200)
  @IdempotencyExempt('Carries a password.')
  @RateLimit({ limit: 5, windowSec: 600, per: 'member' })
  async changePassword(
    @CurrentPrincipal() principal: Principal,
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<{ changed: true }> {
    const { currentPassword, newPassword } = changePasswordInputSchema.parse(body);
    await this.accounts.changePassword(
      { userId: principal.userId, currentSessionId: request.sessionId!, currentPassword, newPassword },
      contextOf(request),
    );
    return { changed: true };
  }

  @Get('sessions')
  async listSessions(
    @CurrentPrincipal() principal: Principal,
    @Req() request: RequestWithPrincipal,
  ): Promise<{ items: SessionSummary[] }> {
    return { items: await this.sessions.list(principal.organizationId, principal.memberId, request.sessionId!) };
  }

  /** Ends one of the person's own sessions — a lost phone, a shared computer. */
  @Delete('sessions/:sessionId')
  async endSession(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
  ): Promise<{ ended: true }> {
    const id = ulidSchema.parse(sessionId);
    const mine = (await this.sessions.list(principal.organizationId, principal.memberId, '')).some(
      (s) => s.id === id,
    );
    if (!mine) throw AppError.notFound('Session');
    await this.sessions.revoke(principal.organizationId, id, 'revoked_by_user');
    return { ended: true };
  }
}
