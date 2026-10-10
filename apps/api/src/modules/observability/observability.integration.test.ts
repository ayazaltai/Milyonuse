import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { AppLogger, requestContext, setLogSink } from '../../common/logging/logger.js';
import { REQUEST_REJECTED } from '../../common/filters/all-exceptions.filter.js';
import { loadEnv } from '../../config/env.js';
import type { Mailer, MailMessage } from '../notifications/mail.port.js';
import { HealthService } from '../health/health.service.js';
import { AlertService } from './alert.service.js';
import { SystemLogService } from './system-log.service.js';
import { APP_URL, PLATFORM_URL } from '../../database/database.testing.js';

/**
 * The kept log (0005): what goes in, what stays out, that nobody can rewrite
 * it, and that errors reach a person — once per window, not once per error.
 */

const platform = new pg.Pool({ connectionString: PLATFORM_URL, max: 3 });
const appPool = new pg.Pool({ connectionString: APP_URL, max: 2 });
const marker = `obs-${Date.now().toString(36)}`;

const env = (overrides: Record<string, string> = {}) =>
  loadEnv({
    DATABASE_URL: APP_URL,
    APP_BASE_URL: 'https://app.example.test',
    ...overrides,
  } as NodeJS.ProcessEnv);

const systemLog = new SystemLogService(platform, env());
const logger = new AppLogger('error');

/** Lines this suite wrote, oldest first. */
async function ours() {
  const { rows } = await platform.query<{
    id: string;
    level: string;
    msg: string;
    method: string | null;
    path: string | null;
    status: number | null;
    organization_id: string | null;
    request_id: string | null;
    context: Record<string, unknown>;
  }>(`SELECT * FROM system_log WHERE msg LIKE $1 ORDER BY id`, [`${marker}%`]);
  return rows;
}

beforeAll(() => {
  setLogSink(systemLog);
});

afterAll(async () => {
  setLogSink(null);
  await platform.query(`DELETE FROM system_log WHERE msg LIKE $1`, [`${marker}%`]);
  await platform.end();
  await appPool.end();
});

describe('what the system log keeps', () => {
  it('keeps an error with the request it happened in — the route, never the path', async () => {
    await new Promise<void>((resolve) => {
      requestContext.run(
        {
          requestId: `${marker}-req`,
          method: 'POST',
          route: '/api/v1/public/interviews/:code/session',
          organizationId: '01JBXR4K8ZQW3E7NDYVM5TGHPA',
        },
        () => {
          logger.error(`${marker} engine refused`, { status: 502, code: 'upstream_failed' });
          resolve();
        },
      );
    });
    await systemLog.flush();

    const [row] = await ours();
    expect(row).toMatchObject({
      level: 'error',
      method: 'POST',
      path: '/api/v1/public/interviews/:code/session',
      status: 502,
      request_id: `${marker}-req`,
    });
    expect(row!.organization_id?.trim()).toBe('01JBXR4K8ZQW3E7NDYVM5TGHPA');
  });

  it('keeps it masked: what is scrubbed from standard error is scrubbed here', async () => {
    logger.error(`${marker} mail to jane.doe@example.com failed`, {
      token: 'sk_live_should_not_be_kept',
    });
    await systemLog.flush();
    const rows = await ours();
    const last = rows[rows.length - 1]!;
    expect(last.msg).not.toContain('jane.doe@example.com');
    expect(JSON.stringify(last.context)).not.toContain('sk_live_should_not_be_kept');
  });

  it('leaves out an ordinary refusal, and keeps a caller being held back', async () => {
    const before = (await ours()).length;
    const refusals = new SystemLogService(platform, env());
    refusals.accept({
      at: new Date(),
      level: 'warn',
      msg: REQUEST_REJECTED,
      context: { status: 404 },
    });
    refusals.accept({
      at: new Date(),
      level: 'warn',
      msg: REQUEST_REJECTED,
      context: { status: 401 },
    });
    expect(refusals.pending).toBe(0);

    refusals.accept({
      at: new Date(),
      level: 'warn',
      msg: REQUEST_REJECTED,
      context: { status: 429 },
    });
    refusals.accept({
      at: new Date(),
      level: 'warn',
      msg: `${marker} pool reconnect`,
      context: {},
    });
    expect(refusals.pending).toBe(2);
    await refusals.flush();
    await platform.query(`DELETE FROM system_log WHERE msg = $1 AND status = 429`, [
      REQUEST_REJECTED,
    ]);
    expect((await ours()).length).toBe(before + 1);
  });

  it('writes each line once, however many flushes race', async () => {
    const before = (await ours()).length;
    logger.error(`${marker} raced`);
    await Promise.all([systemLog.flush(), systemLog.flush(), systemLog.flush()]);
    expect((await ours()).length).toBe(before + 1);
  });
});

describe('who can touch it', () => {
  it('cannot be rewritten — only the alert mark moves', async () => {
    const [row] = await ours();
    await expect(
      platform.query(`UPDATE system_log SET msg = 'nothing happened' WHERE id = $1`, [row!.id]),
    ).rejects.toMatchObject({ hint: 'system_log_immutable' });
    await expect(
      platform.query(`UPDATE system_log SET alerted_at = now() WHERE id = $1`, [row!.id]),
    ).resolves.toMatchObject({ rowCount: 1 });
    await platform.query(`UPDATE system_log SET alerted_at = NULL WHERE id = $1`, [row!.id]);
  });

  it('is out of reach of the role that serves customer traffic', async () => {
    await expect(appPool.query('SELECT 1 FROM system_log LIMIT 1')).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      appPool.query(`INSERT INTO system_log (level, msg) VALUES ('error', 'x')`),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('the error digest', () => {
  const sent: MailMessage[] = [];
  let failing = false;
  const mailer: Mailer = {
    name: 'capturing',
    send: async (message) => {
      if (failing) throw new Error('mailbox unreachable');
      sent.push(message);
    },
  };
  const alerts = new AlertService(
    platform,
    mailer,
    env({ ALERT_EMAILS: 'ops@milyonus.test' }),
    logger,
  );

  beforeEach(async () => {
    sent.length = 0;
    failing = false;
    // Every other error in this database is not ours to mail; mark it sent and
    // start from a clean window.
    await platform.query(
      `UPDATE system_log SET alerted_at = now() - interval '1 day' WHERE alerted_at IS NULL OR alerted_at > now() - interval '1 day'`,
    );
  });

  it('mails nothing to nobody', async () => {
    const silent = new AlertService(platform, mailer, env(), logger);
    expect(await silent.digest()).toMatchObject({ sent: false, reason: 'no_recipients' });
  });

  it('groups new errors into one mail, and not again within the window', async () => {
    for (let i = 0; i < 3; i += 1)
      logger.error(`${marker} evaluation model timed out`, { status: 504 });
    logger.error(`${marker} storage refused`);
    await systemLog.flush();

    // Suites run side by side on one database, so another may have logged an
    // error of its own in the meantime: at least ours, then, and all in one mail.
    const result = await alerts.digest();
    expect(result.sent).toBe(true);
    expect(result.errors).toBeGreaterThanOrEqual(4);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('ops@milyonus.test');
    expect(sent[0]!.subject).toMatch(/^\[Milyonuse\] \d+ errors since \d\d:\d\d UTC$/);
    expect(sent[0]!.text).toContain(`3×  ${marker} evaluation model timed out`);
    expect(sent[0]!.text).toContain('Every line is in system_log, by request id.');

    logger.error(`${marker} another one`);
    await systemLog.flush();
    expect(await alerts.digest()).toMatchObject({ sent: false, reason: 'too_soon' });
    expect(sent).toHaveLength(1);
  });

  it('gives the lines back when the mail could not go, so the next pass tries', async () => {
    logger.error(`${marker} undeliverable`);
    await systemLog.flush();
    failing = true;
    expect(await alerts.digest()).toMatchObject({ sent: false, reason: 'send_failed' });
    const { rows } = await platform.query(`SELECT alerted_at FROM system_log WHERE msg = $1`, [
      `${marker} undeliverable`,
    ]);
    expect(rows[0]!.alerted_at).toBeNull();

    failing = false;
    expect(await alerts.digest()).toMatchObject({ sent: true });
  });
});

describe('retention', () => {
  it('deletes what is older than the deployment keeps', async () => {
    // Old lines cannot be written by rewriting `at`; a line is inserted old.
    await platform.query(
      `INSERT INTO system_log (at, level, msg) VALUES (now() - interval '400 days', 'warn', $1)`,
      [`${marker} ancient`],
    );
    const purged = await new SystemLogService(platform, env({ LOG_RETENTION_DAYS: '90' })).purge();
    expect(purged).toBeGreaterThanOrEqual(1);
    expect((await ours()).some((r) => r.msg === `${marker} ancient`)).toBe(false);
    expect((await ours()).length).toBeGreaterThan(0);
  });
});

describe('the readiness probe reports the scheduled passes', () => {
  it('says when each cadence last finished, and which one is overdue', async () => {
    await platform.query(
      `INSERT INTO worker_heartbeats (cadence, finished_at, ok, failed, ms) VALUES
         ('minute',       now() - interval '30 seconds', true,  '{}', 1200),
         ('quarter-hour', now() - interval '3 hours',    false, '{"ats":"timeout"}', 50),
         ('hour',         now() - interval '20 minutes', true,  '{}', 900)
       ON CONFLICT (cadence) DO UPDATE
         SET finished_at = EXCLUDED.finished_at, ok = EXCLUDED.ok, failed = EXCLUDED.failed, ms = EXCLUDED.ms`,
    );
    const health = new HealthService(
      env({ WORKER_MODE: 'cron', CRON_SECRET: 'c'.repeat(32) }),
      appPool,
    );
    const ready = await health.ready();

    // Readiness is still about serving: a stopped scheduler is reported, not fatal.
    expect(ready.status).toBe('ok');
    expect(ready.workers?.mode).toBe('cron');
    expect(ready.workers?.cadences?.['minute']).toMatchObject({ ok: true, stale: false });
    expect(ready.workers?.cadences?.['quarter-hour']).toMatchObject({ ok: false, stale: true });
    expect(ready.workers?.cadences?.['hour']?.stale).toBe(false);
  });

  it('says only the mode when the workers keep their own timers', async () => {
    const ready = await new HealthService(env(), appPool).ready();
    expect(ready.workers).toEqual({ mode: 'interval' });
  });
});
