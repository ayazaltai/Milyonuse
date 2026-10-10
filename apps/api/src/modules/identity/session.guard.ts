import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '@milyonuse/contracts';
import { AppError } from '../../common/app-error.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import type { RequestWithPrincipal } from '../tenancy/guards/principal.decorator.js';
import { SessionService } from './session.service.js';

/**
 * Turns the session cookie into `request.session`.
 *
 * Runs before PrincipalGuard, which then resolves the membership. Splitting
 * them keeps one concern per guard: this one answers "who is calling", the
 * next answers "what may they do here".
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const cookies = (request as { cookies?: Record<string, string | undefined> }).cookies;
    const token = cookies?.[this.env.SESSION_COOKIE_NAME];
    if (!token) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Sign in to continue.');
    }

    const session = await this.sessions.resolve(token);
    request.session = { userId: session.userId, organizationId: session.organizationId };
    request.sessionId = session.sessionId;
    request.memberId = session.memberId;
    return true;
  }
}
