import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type pg from 'pg';
import { AppLogger } from '../../common/logging/logger.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { PLATFORM_POOL } from '../../database/database.module.js';
import { RunEngine } from '../teams/run-engine.js';
import { ActionService } from '../agent/actions/action.service.js';
import { MemoryWorker } from '../memory/memory.worker.js';
import { OperationsWorker } from '../observability/operations.worker.js';
import { JobWorker } from '../queue/job.worker.js';

export const CADENCES = ['minute', 'quarter-hour', 'hour'] as const;
export type Cadence = (typeof CADENCES)[number];

/**
 * Stop starting new batches after this long, so a pass ends well inside the
 * host's function limit (300 s, apps/api/scripts/vercel-output.mjs) and the
 * next scheduled call picks up the rest. A batch already started finishes: its
 * jobs hold leases, and an abandoned lease only comes back after it expires.
 */
const BUDGET_MS = 200_000;

export interface PassResult {
  cadence: Cadence;
  ran: Record<string, unknown>;
  failed: Record<string, string>;
  ms: number;
}

/**
 * The workers, driven from outside (WORKER_MODE=cron).
 *
 * The same passes the intervals run, awaited end to end, because on a host
 * that freezes an idle process nothing may outlive the request:
 *
 *   minute        the job queue, then the error digest — last, so an error
 *                 from any step before it is in the mail it sends
 *   quarter-hour  the job queue (agent schedules join it in Phase 6)
 *   hour          upkeep of every table that only grows, memory consolidation,
 *                 proposals nobody answered and runs a crash interrupted,
 *                 and the self-probe
 *
 * Every pass is safe to overlap with another: claims use SKIP LOCKED and
 * leases, exactly as two processes with intervals would.
 *
 * Each pass records when it finished (worker_heartbeats, 0005). A scheduler
 * that stops calling fails nothing — it just stops — and the readiness probe
 * reports how long ago each cadence last ran so a probe from outside can see it.
 */
@Injectable()
export class CronService {
  constructor(
    private readonly modules: ModuleRef,
    @Inject(ENV) private readonly env: Env,
    @Inject(PLATFORM_POOL) private readonly platform: pg.Pool,
    private readonly logger: AppLogger,
  ) {}

  async run(cadence: Cadence): Promise<PassResult> {
    const started = Date.now();
    const ran: Record<string, unknown> = {};
    const failed: Record<string, string> = {};

    const step = async (name: string, work: () => Promise<unknown>): Promise<void> => {
      try {
        ran[name] = await work();
      } catch (error) {
        failed[name] = error instanceof Error ? error.message : String(error);
        this.logger.error('cron step failed', { cadence, step: name, err: failed[name] });
      }
    };

    const within = (): boolean => Date.now() - started < BUDGET_MS;
    const get = <T>(type: new (...args: never[]) => T): T => this.modules.get(type, { strict: false });
    const jobs = (): Promise<number> =>
      this.drain(() => get(JobWorker).drain(this.env.JOBS_CONCURRENCY), within);

    if (cadence === 'minute') {
      await step('jobs', jobs);
      await step('alerts', () => get(OperationsWorker).digest());
    } else if (cadence === 'quarter-hour') {
      await step('jobs', jobs);
    } else {
      await step('purge', () => get(OperationsWorker).purge());
      await step('memory', () => get(MemoryWorker).consolidate());
      await step('actions', () => get(ActionService).sweep());
      await step('teams', () => get(RunEngine).sweep());
      await step('selfProbe', () => get(OperationsWorker).probe());
    }

    const result = { cadence, ran, failed, ms: Date.now() - started };
    if (Object.keys(failed).length > 0) this.logger.warn('cron pass incomplete', { ...result });
    await this.heartbeat(result);
    return result;
  }

  private async heartbeat(result: PassResult): Promise<void> {
    try {
      await this.platform.query(
        `INSERT INTO worker_heartbeats (cadence, finished_at, ok, failed, ms)
         VALUES ($1, now(), $2, $3::jsonb, $4)
         ON CONFLICT (cadence) DO UPDATE
           SET finished_at = EXCLUDED.finished_at, ok = EXCLUDED.ok,
               failed = EXCLUDED.failed, ms = EXCLUDED.ms`,
        [result.cadence, Object.keys(result.failed).length === 0, JSON.stringify(result.failed), result.ms],
      );
    } catch (error) {
      this.logger.warn('cron heartbeat not recorded', {
        cadence: result.cadence,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Batch after batch until one comes back empty or the budget is spent. */
  private async drain(batch: () => Promise<number>, within: () => boolean): Promise<number> {
    let total = 0;
    while (within()) {
      const n = await batch();
      total += n;
      if (n === 0) break;
    }
    return total;
  }
}
