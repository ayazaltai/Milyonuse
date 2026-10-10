import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { TenantScope } from './tenant-scope.service.js';

/**
 * The scope opens with BEGIN and the setting in one message, so the id is a
 * literal there. What reaches the database must be an id and nothing else.
 */

function recordingPool(failOn?: RegExp) {
  const sent: string[] = [];
  const release = vi.fn();
  const client = {
    escapeLiteral: (value: string) => `'${value.replace(/'/g, "''")}'`,
    query: vi.fn(async (text: string) => {
      sent.push(text);
      if (failOn?.test(text)) throw new Error(`refused: ${text}`);
      return { rows: [] };
    }),
    release,
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
  return { pool, sent, release, connect: pool.connect as ReturnType<typeof vi.fn> };
}

describe('TenantScope', () => {
  it('refuses anything that is not an organization id before touching a connection', async () => {
    const { pool, connect } = recordingPool();
    const scope = new TenantScope(pool);
    for (const id of [
      "01ARZ3NDEKTSV4RRFFQ69G5FAV'); DROP TABLE members; --",
      '',
      'org_1',
      '01arz3ndektsv4rrffq69g5fav',
    ]) {
      await expect(scope.run(id, async () => 1)).rejects.toThrow(/organization id/);
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it('opens the transaction and binds the tenant in one round trip', async () => {
    const { pool, sent, release } = recordingPool();
    const result = await new TenantScope(pool).run('01ARZ3NDEKTSV4RRFFQ69G5FAV', async (c) => {
      await c.query('SELECT 1');
      return 'done';
    });
    expect(result).toBe('done');
    expect(sent).toEqual([
      "BEGIN; SELECT set_config('app.organization_id', '01ARZ3NDEKTSV4RRFFQ69G5FAV', true)",
      'SELECT 1',
      'COMMIT',
    ]);
    expect(release).toHaveBeenCalledWith(false);
  });

  it('returns a connection that rolled back cleanly to the pool', async () => {
    const { pool, release } = recordingPool(/^SELECT 1$/);
    await expect(
      new TenantScope(pool).run('01ARZ3NDEKTSV4RRFFQ69G5FAV', (c) => c.query('SELECT 1')),
    ).rejects.toThrow(/refused/);
    expect(release).toHaveBeenCalledWith(false);
  });

  it('discards a connection that cannot even roll back', async () => {
    const { pool, release } = recordingPool(/^(SELECT 1|ROLLBACK)$/);
    await expect(
      new TenantScope(pool).run('01ARZ3NDEKTSV4RRFFQ69G5FAV', (c) => c.query('SELECT 1')),
    ).rejects.toThrow(/refused: SELECT 1/);
    expect(release).toHaveBeenCalledWith(true);
  });

  it('binds the acting member when one is named', async () => {
    const { pool, sent } = recordingPool();
    await new TenantScope(pool).run(
      { organizationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', memberId: '01ARZ3NDEKTSV4RRFFQ69G5FAW' },
      async () => undefined,
    );
    expect(sent[0]).toBe(
      "BEGIN; SELECT set_config('app.organization_id', '01ARZ3NDEKTSV4RRFFQ69G5FAV', true)" +
        ", set_config('app.member_id', '01ARZ3NDEKTSV4RRFFQ69G5FAW', true)",
    );
  });

  it('refuses a member that is not an id', async () => {
    const { pool, connect } = recordingPool();
    await expect(
      new TenantScope(pool).run({ organizationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', memberId: "x'; --" }, async () => 1),
    ).rejects.toThrow(/member/);
    expect(connect).not.toHaveBeenCalled();
  });
});
