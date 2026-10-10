import { afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createPool } from './client.js';

/**
 * An idle connection that fails is reported as an 'error' event on the pool.
 * Unheard, Node throws it — and the process, with every request in flight,
 * goes down over a connection nobody was using.
 */

const pools: pg.Pool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
  vi.restoreAllMocks();
});

function pool(onError?: (error: Error) => void): pg.Pool {
  const p = createPool({
    connectionString: 'postgres://nobody@127.0.0.1:1/none',
    ...(onError ? { onError } : {}),
  });
  pools.push(p);
  return p;
}

describe('createPool', () => {
  it('hands a failed idle connection to the caller instead of throwing it', () => {
    const onError = vi.fn();
    const p = pool(onError);
    const error = new Error('Connection terminated unexpectedly');
    expect(() => p.emit('error', error)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('still does not throw with no handler of its own, and says so on stderr', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const p = pool();
    expect(() => p.emit('error', new Error('reset by peer'))).not.toThrow();
    expect(String(write.mock.calls[0]?.[0])).toContain('idle database connection failed');
  });

  it('gives up on a connection attempt in seconds rather than waiting forever', () => {
    const options = (pool() as unknown as { options: pg.PoolConfig }).options;
    expect(options.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(options.connectionTimeoutMillis).toBeLessThanOrEqual(15_000);
    expect(options.keepAlive).toBe(true);
  });
});
