import { DEFAULT_LOCALE, type Locale } from '@milyonuse/contracts';
import type { FastifyRequest } from 'fastify';
import type { SignInContext } from './session.service.js';

/** Where a request came from, as kept on a session and in the audit log. */
export function contextOf(request: FastifyRequest): SignInContext {
  const userAgent = request.headers['user-agent'];
  return { ip: request.ip, userAgent: typeof userAgent === 'string' ? userAgent : undefined };
}

/**
 * The language to write to someone the product does not know yet — an address
 * with no account — read from what their browser prefers. Anyone with an
 * account is written to in the language they chose.
 */
export function requestLocale(request: FastifyRequest): Locale {
  const header = request.headers['accept-language'];
  const first = typeof header === 'string' ? header.split(',')[0]?.trim().toLowerCase() : undefined;
  return first?.startsWith('tr') ? 'tr' : DEFAULT_LOCALE;
}
