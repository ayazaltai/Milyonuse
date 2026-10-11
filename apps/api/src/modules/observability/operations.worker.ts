import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type pg from 'pg';
import { AppLogger } from '../../common/logging/logger.js';
import { purgeRateLimitWindows } from '../../common/rate-limit.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { PLATFORM_POOL } from '../../database/database.module.js';
import { purgeExpiredAccountTokens } from '../identity/account-tokens.js';
import { SessionService } from '../identity/session.service.js';
import { AlertService, type DigestResult } from './alert.service.js';
import { SystemLogService } from './system-log.service.js';

const DIGEST_TICK_MS = 60_000;
const PURGE_TICK_MS = 60 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;

export interface ProbeResult {
  checked: boolean;
  failures: string[];
}

/**
 * The operational tables' upkeep: the error digest every minute; every hour,
 * whatever has outlived its use — the system log past its retention, rate-limit
 * windows, expired account links and idempotency records, ended sessions,
 * long-finished jobs and the agent's expired attachments. On a long-lived
 * server it keeps its own timers; under WORKER_MODE=cron the scheduled passes
 * call it (modules/cron).
 */
@Injectable()
export class OperationsWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly log: SystemLogService,
    private readonly alerts: AlertService,
    private readonly sessions: SessionService,
    @Inject(PLATFORM_POOL) private readonly platform: pg.Pool,
    @Inject(ENV) private readonly env: Env,
    private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    // Tests drive the worker by hand; under WORKER_MODE=cron the host does (cron.controller.ts).
    if (this.env.NODE_ENV === 'test' || this.env.WORKER_MODE === 'cron') return;
    this.every(DIGEST_TICK_MS, () => this.digest());
    this.every(PURGE_TICK_MS, () => this.purge());
    this.every(PURGE_TICK_MS, () => this.probe());
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t);
  }

  /** Writes what is held, then mails new errors. */
  async digest(): Promise<DigestResult> {
    await this.log.flush();
    return this.alerts.digest();
  }

  async purge(): Promise<Record<string, number>> {
    const count = (result: { rowCount: number | null }): number => result.rowCount ?? 0;
    return {
      systemLog: await this.log.purge(),
      rateLimitWindows: await purgeRateLimitWindows(this.platform),
      accountTokens: await purgeExpiredAccountTokens(this.platform),
      sessions: await this.sessions.purgeEnded(),
      idempotencyKeys: count(await this.platform.query(`DELETE FROM idempotency_keys WHERE expires_at <= now()`)),
      // A finished job is kept a fortnight: long enough to answer "did it run?".
      jobs: count(
        await this.platform.query(`DELETE FROM jobs WHERE finished_at < now() - interval '14 days'`),
      ),
      // A table or a document handed to the agent is kept a few days, then goes (0006).
      agentAttachments: count(await this.platform.query(`DELETE FROM agent_attachments WHERE expires_at <= now()`)),
    };
  }

  /**
   * The product as a person reaches it, checked from inside once an hour: the
   * web app answers, and the web app reaches this API. The hourly probe from
   * outside (.github/workflows/uptime.yml) covers this API being down; this
   * covers what that probe cannot be relied on for alone — a scheduler that
   * skips a run — and turns a failure into an error, and so into the digest.
   * Production only: elsewhere the web app is often simply not running.
   */
  async probe(fetcher: typeof fetch = fetch): Promise<ProbeResult> {
    if (this.env.NODE_ENV !== 'production') return { checked: false, failures: [] };
    const base = this.env.APP_BASE_URL.replace(/\/$/, '');
    const checks: [string, string, number][] = [
      ['the web app answers', `${base}/login`, 200],
      // 401 is the answer to an anonymous caller; anything else means the web
      // app's route to this API is broken.
      ['the web app reaches the API', `${base}/api/v1/auth/session`, 401],
    ];
    const failures: string[] = [];
    for (const [name, url, expected] of checks) {
      try {
        const response = await fetcher(url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (response.status !== expected)
          failures.push(`${name}: ${response.status}, expected ${expected}`);
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) this.logger.error('uptime self-probe failed', { failures });
    return { checked: true, failures };
  }

  private every(ms: number, work: () => Promise<unknown>): void {
    const timer = setInterval(() => {
      work().catch((error: unknown) =>
        this.logger.warn('operations pass failed', {
          err: error instanceof Error ? error.message : String(error),
        }),
      );
    }, ms);
    timer.unref();
    this.timers.push(timer);
  }
}
