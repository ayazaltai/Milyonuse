import { createHash } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@milyonuse/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { PLATFORM_POOL } from '../database/database.module.js';
import { AppError } from './app-error.js';

/**
 * Rate limiting.
 *
 * The account routes — signing in, registering, asking for a password link —
 * are counted per email address as well as per caller address: the address a
 * request is about is what a guesser or a mail-bomber aims at, whichever
 * addresses they send from. A route with no subject is limited in total too,
 * which bounds what everyone together can do if an address is shared or forged.
 *
 * Signed-in routes that spend money — every agent turn spends model tokens —
 * are counted per member: the person is who spends them, wherever they sign
 * in from.
 *
 * Counted in the database (rate_limit_windows, 0005), so every instance agrees:
 * a host that runs many short-lived instances would otherwise give each its own
 * empty counters. If the database cannot be reached the count falls back to
 * this process's memory — a looser bound, never an open door. Floods from many
 * sources remain the edge's to absorb.
 */

export interface RateLimitRule {
  /** Calls allowed per window. */
  limit: number;
  windowSec: number;
  /**
   * What is counted: one caller address, the email address a request is about
   * (the body's `email` — a sign-in, a registration, a password link), the
   * signed-in member (behind PrincipalGuard), or every caller together.
   */
  per: 'address' | 'email' | 'member' | 'all';
}

/** Exported for the route inventory (docs/api/routes.md). Holds a RateLimitRule[]. */
export const RATE_LIMIT_KEY = 'milyonuse:rate-limit';

/** At most this many keys are tracked at once, so invented subjects cannot grow memory without bound. */
const MAX_TRACKED = 100_000;

/**
 * Fixed-window counters.
 *
 * Bounded: at capacity, expired windows go first, then the oldest tenth. An
 * attacker cycling through invented subjects can at worst reset some other
 * window early — never exhaust memory.
 */
export class WindowCounters {
  private readonly windows = new Map<string, { count: number; resetsAt: number }>();

  constructor(
    private readonly maxKeys: number = MAX_TRACKED,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one call. Returns the seconds to wait when it is over the limit, otherwise null. */
  hit(key: string, rule: RateLimitRule): number | null {
    const now = this.now();
    let window = this.windows.get(key);

    if (!window || window.resetsAt <= now) {
      this.windows.delete(key);
      if (this.windows.size >= this.maxKeys) this.evict(now);
      window = { count: 0, resetsAt: now + rule.windowSec * 1000 };
      this.windows.set(key, window);
    }

    window.count += 1;
    return window.count > rule.limit
      ? Math.max(1, Math.ceil((window.resetsAt - now) / 1000))
      : null;
  }

  get size(): number {
    return this.windows.size;
  }

  private evict(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetsAt <= now) this.windows.delete(key);
    }
    if (this.windows.size < this.maxKeys) return;

    // Maps iterate in insertion order, so the first keys are the oldest windows.
    let drop = Math.max(1, Math.floor(this.maxKeys / 10));
    for (const key of this.windows.keys()) {
      if (drop-- === 0) break;
      this.windows.delete(key);
    }
  }
}

const counters = new WindowCounters();

/**
 * A digest, not the value: an address is personal data. `route` is `Controller.handler`. Exported so a test can start a window
 * of its own from empty — the counts outlive a test run now.
 */
export function rateLimitKey(route: string, rule: Pick<RateLimitRule, 'per' | 'windowSec'>, subject: string): string {
  return createHash('sha256')
    .update(`${route}\u0000${rule.per}\u0000${rule.windowSec}\u0000${subject}`)
    .digest('hex');
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PLATFORM_POOL) private readonly platform: pg.Pool,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rules = this.reflector.get<RateLimitRule[] | undefined>(RATE_LIMIT_KEY, context.getHandler());
    if (!rules || rules.length === 0) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    // Each route counts on its own: reading the page does not use up starting.
    const route = `${context.getClass().name}.${context.getHandler().name}`;

    let wait: number | null = null;
    for (const rule of rules) {
      const subject = this.subjectOf(request, rule);
      const retryAfter = await this.hit(rateLimitKey(route, rule, subject), rule);
      if (retryAfter !== null) wait = Math.max(wait ?? 0, retryAfter);
    }
    if (wait === null) return true;

    void context.switchToHttp().getResponse<FastifyReply>().header('retry-after', String(wait));
    throw new AppError(
      ErrorCode.RATE_LIMITED,
      'Too many attempts in a short time. Please wait a moment and try again.',
      { context: { route, retryAfter: wait } },
    );
  }

  private subjectOf(request: FastifyRequest, rule: RateLimitRule): string {
    if (rule.per === 'all') return '*';
    if (rule.per === 'address') return request.ip || 'unknown';
    if (rule.per === 'email') {
      // Normalised the way the account schemas normalise it, so "Ada@x" and
      // "ada@x " are one account's attempts. A body without one shares a
      // single window: it is refused by validation straight after anyway.
      const email = (request.body as { email?: unknown } | undefined)?.email;
      return typeof email === 'string' ? email.trim().toLowerCase() : '-';
    }
    // Set by PrincipalGuard, which runs first: the class's guards before the route's.
    const memberId = (request as FastifyRequest & { principal?: { memberId?: string } }).principal?.memberId;
    if (!memberId) throw new Error('A per-member rate limit is only for routes behind PrincipalGuard.');
    return memberId;
  }

  /** Counts one call. Returns the seconds to wait when it is over the limit, otherwise null. */
  private async hit(key: string, rule: RateLimitRule): Promise<number | null> {
    try {
      const { rows } = await this.platform.query<{ hits: number; resets_in: number }>(
        `INSERT INTO rate_limit_windows (key, window_start, hits)
         VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2) * $2), 1)
         ON CONFLICT (key, window_start) DO UPDATE SET hits = rate_limit_windows.hits + 1
         RETURNING hits,
                   ceil(extract(epoch FROM window_start) + $2 - extract(epoch FROM now()))::int
                     AS resets_in`,
        [key, rule.windowSec],
      );
      const row = rows[0]!;
      return row.hits > rule.limit ? Math.max(1, row.resets_in) : null;
    } catch {
      return counters.hit(key, rule);
    }
  }
}

/**
 * Limits the decorated route by every rule given. One decorator, however many
 * rules: guards added twice would run — and count — twice.
 */
export const RateLimit = (...rules: RateLimitRule[]) =>
  applyDecorators(SetMetadata(RATE_LIMIT_KEY, rules), UseGuards(RateLimitGuard));

/** Deletes windows that ended more than a day ago. Returns how many went. */
export async function purgeRateLimitWindows(platform: pg.Pool): Promise<number> {
  const { rowCount } = await platform.query(
    `DELETE FROM rate_limit_windows WHERE window_start < now() - interval '1 day'`,
  );
  return rowCount ?? 0;
}
