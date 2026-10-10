import type pg from 'pg';

/**
 * Connection helpers for integration tests.
 *
 * Tests run against a real PostgreSQL because the invariants being tested —
 * row-level isolation, the last owner, append-only records — are enforced by
 * the database. A mock would assert that the mock works.
 */

export const APP_URL =
  process.env['DATABASE_URL_APP'] ?? 'postgres://milyonuse_app:milyonuse@127.0.0.1:5432/milyonuse';

export const PLATFORM_URL =
  process.env['DATABASE_URL_PLATFORM'] ??
  'postgres://milyonuse_platform:milyonuse@127.0.0.1:5432/milyonuse';

/** The schema owner — for the rules that must hold even for the role that owns the tables. */
export const OWNER_URL =
  process.env['DATABASE_URL_MIGRATOR'] ?? 'postgres://milyonuse:milyonuse@127.0.0.1:5432/milyonuse';

/** Runs `fn` on a connection scoped to one tenant, the way the API does. */
export async function asTenant<T>(
  pool: pg.Pool,
  organizationId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The HINT we attach to domain violations, used to assert on the reason. */
export function hintOf(error: unknown): string | undefined {
  return (error as { hint?: string } | null)?.hint;
}
