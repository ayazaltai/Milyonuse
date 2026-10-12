import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '@milyonuse/contracts';
import type pg from 'pg';
import { AppError } from '../../common/app-error.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { PLATFORM_POOL } from '../../database/database.module.js';
import { AutomationsStore } from './automations.store.js';
import { hookSecret } from './automations.service.js';
import { AutomationLauncher } from './launcher.js';

/** How far a signed timestamp may be from now: a replay older than this is refused. */
export const HOOK_SKEW_SECONDS = 300;
/** The largest body a hook takes. The trigger's payload is capped at 64 KiB by the database. */
export const HOOK_MAX_BYTES = 48 * 1024;

export interface HookAnswer {
  accepted: boolean;
  /** True when the same delivery came before and nothing new was started. */
  duplicate: boolean;
  triggerId: string | null;
}

/**
 * Events from outside (F6 §1): a signed webhook, and mail the inbound
 * provider forwards. Nothing about the caller is trusted but the signature;
 * the automation is found by its address before any tenant is known
 * (PLATFORM_POOL), and everything after is done in its owner's scope. The
 * same delivery twice starts one run — the database holds the key.
 */
@Injectable()
export class HookIntake {
  constructor(
    private readonly store: AutomationsStore,
    private readonly launcher: AutomationLauncher,
    @Inject(PLATFORM_POOL) private readonly platform: pg.Pool,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * `x-milyonuse-signature: sha256=<hex>` over `<timestamp>.<raw body>`, keyed
   * by the hook's secret; `x-milyonuse-timestamp` in seconds.
   */
  async webhook(
    token: string,
    raw: string,
    headers: { signature?: string | undefined; timestamp?: string | undefined; delivery?: string | undefined },
    now = Date.now(),
  ): Promise<HookAnswer> {
    if (Buffer.byteLength(raw) > HOOK_MAX_BYTES) throw new AppError(ErrorCode.VALIDATION_FAILED, `A webhook body is at most ${HOOK_MAX_BYTES} bytes.`);
    const found = await this.find(token, 'webhook');
    const ts = Number(headers.timestamp);
    if (!Number.isInteger(ts) || Math.abs(now / 1000 - ts) > HOOK_SKEW_SECONDS) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'The timestamp is missing or too far from now.');
    }
    const expected = `sha256=${signHook(hookSecret(this.env, token), ts, raw)}`;
    if (!same(headers.signature ?? '', expected)) throw new AppError(ErrorCode.UNAUTHENTICATED, 'The signature does not match.');
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = raw.length > 0 ? JSON.parse(raw) : {};
      payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { body: parsed };
    } catch {
      payload = { body: raw };
    }
    const key = headers.delivery?.trim() ? `delivery:${headers.delivery.trim().slice(0, 120)}` : `body:${digest(raw)}`;
    return this.accept(found, 'webhook', key, payload);
  }

  /**
   * A mail the inbound provider forwards: the bearer is the provider's, the
   * address names the automation. `to` may carry a `+tag`.
   */
  async mail(authorization: string | undefined, body: unknown): Promise<HookAnswer> {
    if (!this.env.INBOUND_MAIL_SECRET) throw new AppError(ErrorCode.NOT_FOUND, 'Not found.');
    if (!same(authorization ?? '', `Bearer ${this.env.INBOUND_MAIL_SECRET}`)) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Not authorised.');
    const mail = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const to = String(mail['to'] ?? '').toLowerCase();
    const token = /([a-z0-9]{24,48})(?:\+[^@]*)?@/.exec(to)?.[1];
    if (!token) throw new AppError(ErrorCode.NOT_FOUND, 'No automation has that address.');
    const found = await this.find(token, 'email');
    const text = String(mail['text'] ?? '').slice(0, 20_000);
    const payload = {
      from: String(mail['from'] ?? '').slice(0, 300),
      subject: String(mail['subject'] ?? '').slice(0, 300),
      text,
    };
    const id = String(mail['messageId'] ?? '').trim();
    const key = id ? `mail:${id.slice(0, 160)}` : `mail:${digest(JSON.stringify(payload))}`;
    return this.accept(found, 'email', key, payload);
  }

  private async find(token: string, kind: 'webhook' | 'email'): Promise<{ id: string; organization_id: string; member_id: string }> {
    // PLATFORM_POOL: the address is all a caller brings; the tenant is learned from it.
    const { rows } = await this.platform.query<{ id: string; organization_id: string; member_id: string }>(
      `SELECT id, organization_id, member_id FROM automations WHERE hook_token = $1 AND kind = $2::automation_kind`,
      [token, kind],
    );
    if (!rows[0]) throw new AppError(ErrorCode.NOT_FOUND, 'No automation has that address.');
    return rows[0];
  }

  private async accept(
    found: { id: string; organization_id: string; member_id: string },
    source: 'webhook' | 'email',
    dedupeKey: string,
    payload: Record<string, unknown>,
  ): Promise<HookAnswer> {
    const principal = await this.launcher.principalOf(found.organization_id, found.member_id);
    if (!principal) throw new AppError(ErrorCode.NOT_FOUND, 'No automation has that address.');
    const trigger = await this.store.run(principal, async (client) => {
      const automation = await this.store.get(client, found.id);
      return this.launcher.accept(client, principal, automation, { source, dedupeKey, payload });
    });
    if (trigger) this.launcher.kick();
    return { accepted: trigger !== null, duplicate: trigger === null, triggerId: trigger?.id ?? null };
  }
}

/** What a sender computes: hex HMAC-SHA256 of `<timestamp>.<body>` with the hook's secret. */
export function signHook(secret: string, timestamp: number, raw: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 40);
}

/** Constant-time over digests, so neither content nor length leaks. */
function same(given: string, expected: string): boolean {
  const d = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(d(given), d(expected));
}
