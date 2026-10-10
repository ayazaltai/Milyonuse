import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import {
  type Me,
  type Principal,
  forgotPasswordInputSchema,
  passwordSignInInputSchema,
  registerInputSchema,
  resetPasswordInputSchema,
  verifyEmailInputSchema,
} from '@milyonuse/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RateLimit } from '../../common/rate-limit.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { CurrentPrincipal, type RequestWithPrincipal } from '../tenancy/guards/principal.decorator.js';
import { PrincipalGuard } from '../tenancy/guards/principal.guard.js';
import { IdempotencyExempt } from '../tenancy/idempotency.js';
import { AccountService, type DevelopmentLink } from './account.service.js';
import { clearedCookieOptions, sessionCookieOptions } from './cookie.js';
import { ProfileService } from './profile.service.js';
import { contextOf, requestLocale } from './request-context.js';
import { SessionGuard } from './session.guard.js';
import { SessionService } from './session.service.js';

/**
 * Signing up, in and out.
 *
 * The public routes have no session — that is what they are for — and each is
 * limited per caller address, and per email address wherever one is in the
 * body: that address is what a guesser or a mail-bomber aims at, whatever they
 * send from (common/rate-limit.ts). None of them takes an Idempotency-Key: a
 * request carrying a password or a one-time token is not something to store
 * and replay.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly accounts: AccountService,
    private readonly sessions: SessionService,
    private readonly profiles: ProfileService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Registers: mails a link to confirm the address. The same answer for every address. */
  @Post('register')
  @HttpCode(202)
  @IdempotencyExempt('Carries a password; registering twice mails the same link again.')
  @RateLimit(
    { limit: 10, windowSec: 3600, per: 'address' },
    { limit: 3, windowSec: 3600, per: 'email' },
    { limit: 500, windowSec: 3600, per: 'all' },
  )
  async register(@Body() body: unknown): Promise<{ status: 'verification_sent' } & DevelopmentLink> {
    return { status: 'verification_sent', ...(await this.accounts.register(registerInputSchema.parse(body))) };
  }

  /** Follows the registration link: account, personal workspace and a session, together. */
  @Post('verify')
  @HttpCode(201)
  @IdempotencyExempt('A one-time token, spent by the first call.')
  @RateLimit({ limit: 20, windowSec: 600, per: 'address' })
  async verify(@Body() body: unknown, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const { token } = verifyEmailInputSchema.parse(body);
    const session = await this.accounts.verifyEmail(token, contextOf(request));
    void reply
      .setCookie(this.env.SESSION_COOKIE_NAME, session.token, sessionCookieOptions(this.env, session.expiresAt))
      .send({ status: 'signed_in' });
  }

  @Post('login')
  @HttpCode(200)
  @IdempotencyExempt('Carries a password.')
  @RateLimit(
    { limit: 60, windowSec: 600, per: 'address' },
    { limit: 5, windowSec: 600, per: 'email' },
  )
  async login(@Body() body: unknown, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const { email, password } = passwordSignInInputSchema.parse(body);
    const session = await this.accounts.signIn(email, password, contextOf(request));
    void reply
      .setCookie(this.env.SESSION_COOKIE_NAME, session.token, sessionCookieOptions(this.env, session.expiresAt))
      .send({ status: 'signed_in' });
  }

  @Post('logout')
  @HttpCode(200)
  @IdempotencyExempt('Signing out twice leaves the caller signed out once.')
  @UseGuards(SessionGuard, PrincipalGuard)
  async logout(
    @CurrentPrincipal() principal: Principal,
    @Req() request: RequestWithPrincipal,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (request.sessionId) await this.sessions.revoke(principal.organizationId, request.sessionId, 'sign_out');
    void reply.clearCookie(this.env.SESSION_COOKIE_NAME, clearedCookieOptions(this.env)).send({ signedOut: true });
  }

  /** Mails a link to set a new password. The same answer for every address. */
  @Post('password/forgot')
  @HttpCode(202)
  @IdempotencyExempt('Asking twice mails a fresh link, which replaces the last.')
  @RateLimit(
    { limit: 10, windowSec: 3600, per: 'address' },
    { limit: 3, windowSec: 3600, per: 'email' },
  )
  async forgotPassword(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{ status: 'link_sent' } & DevelopmentLink> {
    const { email } = forgotPasswordInputSchema.parse(body);
    return { status: 'link_sent', ...(await this.accounts.requestPasswordLink(email, requestLocale(request))) };
  }

  /** Sets the password a link was issued for, and signs the person out everywhere. */
  @Post('password/reset')
  @HttpCode(200)
  @IdempotencyExempt('Carries a password and a one-time token.')
  @RateLimit({ limit: 20, windowSec: 600, per: 'address' })
  async resetPassword(@Body() body: unknown, @Req() request: FastifyRequest): Promise<{ reset: true }> {
    const { token, password } = resetPasswordInputSchema.parse(body);
    await this.accounts.resetPassword(token, password, contextOf(request));
    return { reset: true };
  }

  /** Who is signed in, and where. 401 when nobody is — the web app's first question on every page. */
  @Get('session')
  @UseGuards(SessionGuard, PrincipalGuard)
  async session(@CurrentPrincipal() principal: Principal): Promise<Me> {
    return this.profiles.me(principal);
  }
}
