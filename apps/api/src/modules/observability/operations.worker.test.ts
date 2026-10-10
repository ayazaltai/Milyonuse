import { describe, expect, it, vi } from 'vitest';
import { AppLogger } from '../../common/logging/logger.js';
import { type Env, loadEnv } from '../../config/env.js';
import type { AlertService } from './alert.service.js';
import { OperationsWorker } from './operations.worker.js';
import type { SessionService } from '../identity/session.service.js';
import type { SystemLogService } from './system-log.service.js';

/**
 * The hourly look at the product from inside: the web app answers, and it
 * reaches this API. A failure is logged as an error — which is what puts it
 * in the next digest.
 */

const production = {
  ...loadEnv({ DATABASE_URL: 'postgres://x@localhost/x' } as NodeJS.ProcessEnv),
  NODE_ENV: 'production',
  APP_BASE_URL: 'https://app.example.test/',
} as Env;

function worker(env: Env) {
  const logger = new AppLogger('error');
  const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  const w = new OperationsWorker(
    {} as SystemLogService,
    {} as AlertService,
    {} as SessionService,
    {} as never,
    env,
    logger,
  );
  return { w, error };
}

const answering = (statuses: Record<string, number>) =>
  (async (url: string | URL | Request) =>
    new Response(null, { status: statuses[String(url)] ?? 599 })) as typeof fetch;

describe('the uptime self-probe', () => {
  it('passes when the web app answers and reaches the API', async () => {
    const { w, error } = worker(production);
    const result = await w.probe(
      answering({
        'https://app.example.test/login': 200,
        'https://app.example.test/api/v1/auth/session': 401,
      }),
    );
    expect(result).toEqual({ checked: true, failures: [] });
    expect(error).not.toHaveBeenCalled();
  });

  it('logs an error — and so reaches the digest — when the web app cannot reach the API', async () => {
    const { w, error } = worker(production);
    const result = await w.probe(
      answering({
        'https://app.example.test/login': 200,
        'https://app.example.test/api/v1/auth/session': 404,
      }),
    );
    expect(result.failures).toEqual(['the web app reaches the API: 404, expected 401']);
    expect(error).toHaveBeenCalledWith('uptime self-probe failed', { failures: result.failures });
  });

  it('reports a web app that does not answer at all', async () => {
    const { w } = worker(production);
    const result = await w.probe((async () => {
      throw new Error('getaddrinfo ENOTFOUND app.example.test');
    }) as typeof fetch);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toContain('ENOTFOUND');
  });

  it('checks nothing outside production, where the web app is often not running', async () => {
    const { w } = worker(
      loadEnv({ DATABASE_URL: 'postgres://x@localhost/x' } as NodeJS.ProcessEnv),
    );
    expect(await w.probe(answering({}))).toEqual({ checked: false, failures: [] });
  });
});
