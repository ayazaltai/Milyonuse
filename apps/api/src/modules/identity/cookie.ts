import type { CookieSerializeOptions } from '@fastify/cookie';
import type { Env } from '../../config/env.js';

/**
 * Session cookie settings.
 *
 * httpOnly keeps it away from scripts, so an XSS bug cannot lift the session.
 * sameSite 'lax' still arrives on a top-level navigation back into the app,
 * which 'strict' would drop. secure is off only in development, where there is
 * no TLS to be secure about.
 */
export function sessionCookieOptions(env: Env, expiresAt: Date): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV !== 'development',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
    ...(env.SESSION_COOKIE_DOMAIN ? { domain: env.SESSION_COOKIE_DOMAIN } : {}),
  };
}

export function clearedCookieOptions(env: Env): CookieSerializeOptions {
  return { ...sessionCookieOptions(env, new Date(0)), maxAge: 0 };
}
