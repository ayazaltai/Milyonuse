import type { FastifyRequest } from 'fastify';
import type { SignInContext } from './session.service.js';

/** Where a request came from, as kept on a session and in the audit log. */
export function contextOf(request: FastifyRequest): SignInContext {
  const userAgent = request.headers['user-agent'];
  return { ip: request.ip, userAgent: typeof userAgent === 'string' ? userAgent : undefined };
}
