import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type pg from 'pg';
import { AppLogger } from '../../common/logging/logger.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { PLATFORM_POOL } from '../../database/database.module.js';
import { type ClaimedJob, type JobOutcome, JobRegistry, PermanentJobError } from './job.js';

const TICK_MS = 5_000;
/** Far longer than sending a message takes; a dead worker's jobs come back after it. */
const LEASE_MINUTES = 5;
/** Retries wait 1, 2, 4, 8… minutes, never more than an hour. */
const MAX_BACKOFF_MINUTES = 60;

/**
 * Runs the durable queue (jobs, 0005).
 *
 * The queue is a table, so a deploy, a crash or a scale-down leaves the work where it was and
 * the next process picks it up. Each tick:
 *
 *   recover  a lease past its expiry belongs to a process that died — its job
 *            goes back in the queue, or fails if it has used its attempts
 *   claim    queued jobs whose time has come, with SKIP LOCKED, so two
 *            processes never run the same one
 *   run      the kind's handler, which does its work in tenant scope
 *
 * The queue's own bookkeeping — claiming, recovering, finishing — spans
 * tenants and uses the platform pool. The work never does.
 */
@Injectable()
export class JobWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private again = false;
  private inFlight = 0;
  private readonly running = new Set<Promise<unknown>>();

  constructor(
    private readonly registry: JobRegistry,
    @Inject(PLATFORM_POOL) private readonly platform: pg.Pool,
    @Inject(ENV) private readonly env: Env,
    private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    // Tests drive the worker by hand; under WORKER_MODE=cron the host does (cron.controller.ts).
    if (this.env.NODE_ENV === 'test' || this.env.WORKER_MODE === 'cron') return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    // A message half-sent is better finished and recorded than abandoned.
    await Promise.allSettled([...this.running]);
  }

  /** Runs a tick soon — after a launch, say — without waiting for the interval. */
  kick(): void {
    // Under cron nothing may outlive the request that started it: the host
    // freezes the process after the response. The next scheduled pass runs it.
    if (this.env.NODE_ENV === 'test' || this.env.WORKER_MODE === 'cron') return;
    if (this.ticking) {
      this.again = true;
      return;
    }
    setImmediate(() => void this.tick());
  }

  /** One pass, awaited end to end. Tests drive the queue through this. */
  async drain(limit = this.env.JOBS_CONCURRENCY): Promise<number> {
    await this.recover();
    const jobs = await this.claim(limit);
    await Promise.all(jobs.map((job) => this.run(job)));
    return jobs.length;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;

    try {
      await this.recover();
      const free = this.env.JOBS_CONCURRENCY - this.inFlight;
      if (free > 0) {
        for (const job of await this.claim(free)) {
          this.inFlight += 1;
          const run = this.run(job).finally(() => {
            this.inFlight -= 1;
            this.running.delete(run);
            this.kick();
          });
          this.running.add(run);
        }
      }
    } catch (error) {
      // Never out of the interval: every background job runs through it.
      this.logger.error('job tick failed', { err: error instanceof Error ? error.message : String(error) });
    } finally {
      this.ticking = false;
      if (this.again) {
        this.again = false;
        setImmediate(() => void this.tick());
      }
    }
  }

  private async run(job: ClaimedJob): Promise<void> {
    const handler = this.registry.handlerFor(job.kind);
    if (!handler) {
      await this.fail(job, `No handler is registered for ${job.kind}`);
      return;
    }

    let outcome: JobOutcome;
    try {
      outcome = await handler.handle(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof PermanentJobError || job.attempts >= job.maxAttempts) {
        await this.fail(job, message);
      } else {
        await this.retry(job, message);
      }
      return;
    }

    await this.platform.query(
      `UPDATE jobs
       SET status = $2::job_status, lease_expires_at = NULL, finished_at = now(), last_error = $3
       WHERE id = $1 AND status = 'running'`,
      [job.id, outcome.status, outcome.status === 'skipped' ? outcome.reason.slice(0, 1000) : null],
    );
  }

  private async retry(job: ClaimedJob, message: string): Promise<void> {
    const minutes = Math.min(MAX_BACKOFF_MINUTES, 2 ** (job.attempts - 1));
    // A little jitter, so a burst of failures does not come back as a burst.
    const seconds = Math.round(minutes * 60 * (0.8 + Math.random() * 0.4));
    await this.platform.query(
      `UPDATE jobs
       SET status = 'queued', lease_expires_at = NULL, last_error = $2,
           run_at = now() + make_interval(secs => $3)
       WHERE id = $1 AND status = 'running'`,
      [job.id, message.slice(0, 1000), seconds],
    );
    this.logger.warn('job will be retried', { jobId: job.id, kind: job.kind, attempt: job.attempts, inSeconds: seconds });
  }

  private async fail(job: ClaimedJob, message: string): Promise<void> {
    await this.platform.query(
      `UPDATE jobs
       SET status = 'failed', lease_expires_at = NULL, finished_at = now(), last_error = $2
       WHERE id = $1 AND status = 'running'`,
      [job.id, message.slice(0, 1000)],
    );
    this.logger.error('job failed', { jobId: job.id, kind: job.kind, attempts: job.attempts });
  }

  private async recover(): Promise<void> {
    const { rowCount } = await this.platform.query(
      `UPDATE jobs
       SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END::job_status,
           finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
           lease_expires_at = NULL, run_at = now(),
           last_error = 'The process running it stopped before it finished'
       WHERE status = 'running' AND lease_expires_at < now()`,
    );
    if (rowCount) this.logger.warn('job leases recovered', { count: rowCount });
  }

  private async claim(limit: number): Promise<ClaimedJob[]> {
    if (limit <= 0) return [];
    const { rows } = await this.platform.query<{
      id: string;
      organization_id: string;
      kind: string;
      payload: Record<string, unknown>;
      attempts: number;
      max_attempts: number;
    }>(
      `UPDATE jobs j
       SET status = 'running', attempts = j.attempts + 1,
           lease_expires_at = now() + make_interval(mins => $2),
           started_at = COALESCE(j.started_at, now())
       FROM (
         SELECT id FROM jobs
         WHERE status = 'queued' AND run_at <= now()
         ORDER BY run_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       ) picked
       WHERE j.id = picked.id
       RETURNING j.id, j.organization_id, j.kind, j.payload, j.attempts, j.max_attempts`,
      [limit, LEASE_MINUTES],
    );
    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      kind: r.kind,
      payload: r.payload,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
    }));
  }
}
