import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { ErrorCode } from '@milyonuse/contracts';
import { AppError } from '../../../common/app-error.js';
import { requestContext } from '../../../common/logging/logger.js';
import { PrincipalService } from '../principal.service.js';
import type { RequestWithPrincipal } from './principal.decorator.js';

/**
 * Resolves the caller into a Principal and attaches it to the request.
 *
 * The user and organization come from the session, which is established by the
 * identity layer. Note what is *not* consulted: the request body, the query
 * string, and any header naming an organization. Those are client-controlled,
 * and a tenant identifier from a client is a claim rather than an
 * authorisation.
 */
@Injectable()
export class PrincipalGuard implements CanActivate {
  constructor(private readonly principals: PrincipalService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const session = request.session;

    if (!session?.userId || !session.organizationId) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Sign in to continue.');
    }

    const principal = await this.principals.resolve(session.userId, session.organizationId);
    request.principal = principal;

    // Carry identity into every log line for the rest of this request.
    const store = requestContext.getStore();
    if (store) {
      store.organizationId = principal.organizationId;
      store.userId = principal.userId;
    }

    return true;
  }
}
