import type { ModuleRef } from '@nestjs/core';
import type { FastifyReply } from 'fastify';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { AppLogger } from '../../common/logging/logger.js';
import { loadEnv, type Env } from '../../config/env.js';
import { OperationsWorker } from '../observability/operations.worker.js';
import { JobWorker } from '../queue/job.worker.js';
import { CronController } from './cron.controller.js';
import { CronService } from './cron.service.js';

const SECRET = 's'.repeat(40);

function env(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    DATABASE_URL: 'postgres://x@localhost/x',
    WORKER_MODE: 'cron',
    CRON_SECRET: SECRET,
    ...overrides,
  } as NodeJS.ProcessEnv);
}

/** Workers that record what they were asked to do, with queues that empty. */
function fakes(options: { jobBatches?: number[]; failJobs?: boolean } = {}) {
  const calls: string[] = [];
  const jobBatches = [...(options.jobBatches ?? [2, 1, 0])];
  const byType = new Map<unknown, unknown>([
    [
      JobWorker,
      {
        drain: async () => {
          calls.push('jobs');
          if (options.failJobs) throw new Error('database unreachable');
          return jobBatches.shift() ?? 0;
        },
      },
    ],
    [
      OperationsWorker,
      {
        digest: async () => (calls.push('alerts'), { sent: false, errors: 0 }),
        purge: async () => (calls.push('purge'), {}),
        probe: async () => (calls.push('selfProbe'), { checked: false, failures: [] }),
      },
    ],
  ]);
  const modules = { get: (type: unknown) => byType.get(type) } as unknown as ModuleRef;
  return { calls, modules };
}

/** A pool that keeps the heartbeats it is asked to record. */
function heartbeats() {
  const recorded: unknown[][] = [];
  const pool = {
    query: async (_text: string, params: unknown[]) => {
      recorded.push(params);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as pg.Pool;
  return { recorded, pool };
}

const service = (modules: ModuleRef, e: Env = env(), pool: pg.Pool = heartbeats().pool) =>
  new CronService(modules, e, pool, new AppLogger('error'));

describe('CronService', () => {
  it('runs a minute pass in order, draining the queue until a batch comes back empty', async () => {
    const { calls, modules } = fakes();
    const result = await service(modules).run('minute');

    expect(calls).toEqual(['jobs', 'jobs', 'jobs', 'alerts']);
    expect(result.ran).toMatchObject({ jobs: 3 });
    expect(result.failed).toEqual({});
  });

  it('keeps going past a failed step, and reports it', async () => {
    const { calls, modules } = fakes({ failJobs: true });
    const result = await service(modules).run('minute');

    expect(calls).toContain('alerts');
    expect(result.failed).toEqual({ jobs: 'database unreachable' });
  });

  it('records when each pass finished, and whether every step did', async () => {
    const clean = heartbeats();
    await service(fakes().modules, env(), clean.pool).run('minute');
    expect(clean.recorded).toHaveLength(1);
    expect(clean.recorded[0]!.slice(0, 3)).toEqual(['minute', true, '{}']);

    const broken = heartbeats();
    await service(fakes({ failJobs: true }).modules, env(), broken.pool).run('minute');
    expect(broken.recorded[0]!.slice(0, 3)).toEqual([
      'minute',
      false,
      JSON.stringify({ jobs: 'database unreachable' }),
    ]);
  });

  it('runs the slower cadences on their own', async () => {
    const quarter = fakes();
    await service(quarter.modules).run('quarter-hour');
    expect(quarter.calls).toEqual(['jobs', 'jobs', 'jobs']);

    const hour = fakes();
    await service(hour.modules).run('hour');
    expect(hour.calls).toEqual(['purge', 'selfProbe']);
  });
});

describe('CronController', () => {
  function reply() {
    const sent: { status?: number; body?: unknown } = {};
    const r = {
      status(code: number) {
        sent.status = code;
        return r;
      },
      send(body: unknown) {
        sent.body = body;
        return r;
      },
    };
    return { sent, reply: r as unknown as FastifyReply };
  }

  function controller(overrides: Record<string, string> = {}, options?: { failJobs?: boolean }) {
    const e = env(overrides);
    const { modules } = fakes(options);
    return new CronController(service(modules, e), e);
  }

  it('is not there at all while the workers keep their own timers', async () => {
    const c = controller({ WORKER_MODE: 'interval' });
    await expect(c.run('minute', `Bearer ${SECRET}`, reply().reply)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('refuses a caller without the secret', async () => {
    const c = controller();
    await expect(c.run('minute', undefined, reply().reply)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    await expect(c.run('minute', `Bearer ${SECRET}x`, reply().reply)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    await expect(c.run('minute', SECRET, reply().reply)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('knows only its cadences', async () => {
    await expect(
      controller().run('weekly', `Bearer ${SECRET}`, reply().reply),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('answers 200 for a clean pass and 500 for one with a failed step', async () => {
    const clean = reply();
    await controller().run('minute', `Bearer ${SECRET}`, clean.reply);
    expect(clean.sent.status).toBe(200);

    const broken = reply();
    await controller({}, { failJobs: true }).run('minute', `Bearer ${SECRET}`, broken.reply);
    expect(broken.sent.status).toBe(500);
    expect(broken.sent.body).toMatchObject({ failed: { jobs: 'database unreachable' } });
  });
});
