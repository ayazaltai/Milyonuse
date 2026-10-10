import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Principal } from '@milyonuse/contracts';
import type { FastifyRequest } from 'fastify';

/** The authenticated caller, as resolved by PrincipalGuard. */
export interface RequestWithPrincipal extends FastifyRequest {
  principal?: Principal;
  session?: { userId: string; organizationId: string };
  /** Set by SessionGuard alongside `session`. */
  sessionId?: string;
  memberId?: string;
}

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const request = ctx.switchToHttp().getRequest<RequestWithPrincipal>();
    if (!request.principal) {
      // Reaching a handler without a principal means the guard was not applied.
      // Failing loudly here beats a handler quietly treating undefined as
      // "no restrictions".
      throw new Error('CurrentPrincipal used on a route without PrincipalGuard');
    }
    return request.principal;
  },
);
