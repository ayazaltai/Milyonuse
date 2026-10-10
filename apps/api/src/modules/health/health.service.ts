import { Inject, Injectable } from '@nestjs/common';
import type { HealthResponse } from '@milyonuse/contracts';
import type pg from 'pg';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { APP_POOL } from '../../database/database.module.js';

const startedAt = Date.now();
const VERSION = process.env['VERCEL_GIT_COMMIT_SHA']?.slice(0, 12) ?? '0.0.0';

/**
 * How late each scheduled pass may be before it counts as stopped: a few of
 * its own intervals, so one slow or skipped call is not an alarm.
 */
const STALE_AFTER_SECONDS = { minute: 10 * 60, 'quarter-hour': 45 * 60, hour: 150 * 60 } as const;
type Cadence = keyof typeof STALE_AFTER_SECONDS;

/** A worker_heartbeats row as read, with its age in seconds by the database's clock. */
export interface HeartbeatRow {
  cadence: string;
  finished_at: Date;
  ok: boolean;
  age: number;
  first_finished_at: Date;
}

/**
 * Whether each scheduled pass is overdue. A pass that has finished is judged by
 * its last finish. One that never has is overdue only once the scheduler has
 * been calling — since the first finish of any pass — for longer than that
 * pass may be late: on a new database the hourly pass has not come round yet.
 * Nothing finished at all is overdue.
 */
export function judgeCadences(
  rows: HeartbeatRow[],
): NonNullable<NonNullable<HealthResponse['workers']>['cadences']> {
  let calling: number | null = null;
  for (const row of rows) {
    const since = row.age + (row.finished_at.getTime() - row.first_finished_at.getTime()) / 1000;
    calling = calling === null ? since : Math.max(calling, since);
  }
  const cadences: NonNullable<NonNullable<HealthResponse['workers']>['cadences']> = {};
  for (const cadence of Object.keys(STALE_AFTER_SECONDS) as Cadence[]) {
    const row = rows.find((r) => r.cadence === cadence);
    cadences[cadence] = row
      ? {
          finishedAt: row.finished_at.toISOString(),
          ageSeconds: row.age,
          ok: row.ok,
          stale: row.age > STALE_AFTER_SECONDS[cadence],
        }
      : {
          finishedAt: null,
          ageSeconds: null,
          ok: null,
          stale: calling === null || calling > STALE_AFTER_SECONDS[cadence],
        };
  }
  return cadences;
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(APP_POOL) private readonly pool: pg.Pool,
  ) {}

  /** Liveness: the process is running. Deliberately checks nothing external —
      a restart cannot fix an unreachable database, so it must not trigger one. */
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: this instance can serve traffic right now. */
  async ready(): Promise<HealthResponse> {
    const dependencies: Record<string, 'up' | 'down' | 'degraded'> = {
      database: await this.checkDatabase(),
    };

    const anyDown = Object.values(dependencies).includes('down');

    return {
      status: anyDown ? 'unavailable' : 'ok',
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      dependencies,
      workers:
        this.env.WORKER_MODE === 'cron' && dependencies['database'] === 'up'
          ? { mode: 'cron', cadences: await this.heartbeats() }
          : { mode: this.env.WORKER_MODE },
    };
  }

  /** When each scheduled pass last finished — read, never decided on (see workerCadenceSchema). */
  private async heartbeats(): Promise<NonNullable<HealthResponse['workers']>['cadences']> {
    let rows: HeartbeatRow[] = [];
    try {
      ({ rows } = await this.pool.query(
        `SELECT cadence, finished_at, first_finished_at, ok,
                extract(epoch FROM now() - finished_at)::int AS age
           FROM worker_heartbeats`,
      ));
    } catch {
      // Readiness is about serving; a heartbeat that cannot be read is reported as unknown.
    }
    return judgeCadences(rows);
  }

  private async checkDatabase(): Promise<'up' | 'down'> {
    try {
      const client = await this.pool.connect();
      try {
        await client.query('SELECT 1');
        return 'up';
      } finally {
        client.release();
      }
    } catch {
      return 'down';
    }
  }
}
