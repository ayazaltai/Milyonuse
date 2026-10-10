import { afterAll, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import pg from 'pg';
import { RateLimit, RateLimitGuard } from './rate-limit.js';
import { PLATFORM_URL } from '../database/database.testing.js';

/**
 * The counters live in the database (0005) so that every instance agrees. A
 * host that runs many short-lived instances would otherwise hand each one an
 * empty count — and a limit that resets whenever the host starts a new
 * instance is not a limit.
 */

const platform = new pg.Pool({ connectionString: PLATFORM_URL, max: 4 });
const run = Date.now().toString(36);

afterAll(async () => {
  await platform.end();
});

class Surface {
  @RateLimit({ limit: 3, windowSec: 600, per: 'email' })
  signIn(): void {}

  @RateLimit({ limit: 2, windowSec: 3600, per: 'address' }, { limit: 3, windowSec: 3600, per: 'all' })
  report(): void {}
}

interface Outcome {
  allowed: boolean;
  code?: string | undefined;
  retryAfter: string | undefined;
}

function call(
  guard: RateLimitGuard,
  method: 'signIn' | 'report',
  params: { email?: string; ip?: string },
): Promise<Outcome> {
  const headers: Record<string, string> = {};
  const context = {
    getClass: () => Surface,
    getHandler: () => Surface.prototype[method],
    switchToHttp: () => ({
      getRequest: () => ({ body: { email: params.email }, ip: params.ip ?? '203.0.113.9' }),
      getResponse: () => ({
        header: (name: string, value: string) => {
          headers[name] = value;
        },
      }),
    }),
  } as unknown as ExecutionContext;
  return guard.canActivate(context).then(
    () => ({ allowed: true, retryAfter: headers['retry-after'] }),
    (error: { code?: string }) => ({ allowed: false, code: error.code, retryAfter: headers['retry-after'] }),
  );
}

describe('rate limits every instance agrees on', () => {
  it('counts one email address across instances, and says how long to wait', async () => {
    const instanceA = new RateLimitGuard(new Reflector(), platform);
    const instanceB = new RateLimitGuard(new Reflector(), platform);
    const email = `ada-${run}@example.com`;

    expect((await call(instanceA, 'signIn', { email })).allowed).toBe(true);
    expect((await call(instanceB, 'signIn', { email: email.toUpperCase() })).allowed).toBe(true);
    expect((await call(instanceA, 'signIn', { email })).allowed).toBe(true);

    const refused = await call(instanceB, 'signIn', { email });
    expect(refused).toMatchObject({ allowed: false, code: 'rate_limited' });
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);
    expect(Number(refused.retryAfter)).toBeLessThanOrEqual(600);

    // Another account is untouched by the first one's attempts.
    expect((await call(instanceB, 'signIn', { email: `other-${run}@example.com` })).allowed).toBe(true);
  });

  it('keeps no email and no address — only digests', async () => {
    const { rows } = await platform.query<{ n: string }>(
      `SELECT count(*) AS n FROM rate_limit_windows WHERE key LIKE $1`,
      [`%${run}%`],
    );
    expect(rows[0]!.n).toBe('0');
  });

  it('holds one sender back per address, and everyone together in total', async () => {
    // Every rule of this route is counted per route and window, so this suite
    // gets fresh windows by using addresses of its own; the total is shared
    // by design, so it is exercised from its current count.
    const guard = new RateLimitGuard(new Reflector(), platform);
    const ip = `198.51.100.${Math.floor(Math.random() * 250)}`;
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await call(guard, 'report', { ip }));
    expect(results.filter((r) => !r.allowed).length).toBeGreaterThanOrEqual(2);
    expect(results.every((r) => r.allowed || r.code === 'rate_limited')).toBe(true);

    // Past the total, a fresh address is refused too.
    for (let i = 0; i < 4; i += 1) await call(guard, 'report', { ip: `192.0.2.${i}` });
    expect((await call(guard, 'report', { ip: '192.0.2.200' })).allowed).toBe(false);
  });

  it('falls back to this process if the database cannot count, and still refuses past the limit', async () => {
    const broken = { query: () => Promise.reject(new Error('database unreachable')) } as unknown as pg.Pool;
    const guard = new RateLimitGuard(new Reflector(), broken);
    const email = `offline-${run}@example.com`;
    for (let i = 0; i < 3; i += 1) expect((await call(guard, 'signIn', { email })).allowed).toBe(true);
    expect((await call(guard, 'signIn', { email })).allowed).toBe(false);
  });
});
