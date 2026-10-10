import type pg from 'pg';

export interface RlsPreflightResult {
  role: string;
  isSuperuser: boolean;
  bypassesRls: boolean;
  unprotectedTables: string[];
}

/**
 * Confirms at boot that row-level security is actually in force.
 *
 * Every isolation guarantee in this system rests on two facts that are easy to
 * break from outside the codebase and impossible to notice from inside it:
 *
 *   1. the application role is neither a superuser nor BYPASSRLS
 *   2. every tenant table has RLS enabled *and* forced
 *
 * Point a correct build at a DATABASE_URL that happens to be a superuser and
 * every policy silently stops applying. Nothing fails, no test goes red, and
 * one customer's query returns another customer's rows. Checking it costs one
 * query at startup.
 */
export async function runRlsPreflight(pool: pg.Pool): Promise<RlsPreflightResult> {
  const client = await pool.connect();
  try {
    const role = await client.query<{
      role: string;
      is_superuser: boolean;
      bypasses_rls: boolean;
    }>(
      `SELECT current_user AS role,
              rolsuper     AS is_superuser,
              rolbypassrls AS bypasses_rls
       FROM pg_roles WHERE rolname = current_user`,
    );

    // A tenant table without rowsecurity, or with rowsecurity but not forced,
    // is readable in full by its owner.
    //
    // Scoped to tables this role can actually reach: a table it has no
    // privilege on (system_log, 0005) is not its isolation problem.
    const unprotected = await client.query<{ tablename: string }>(
      `SELECT c.relname AS tablename
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
         AND EXISTS (
           SELECT 1 FROM pg_attribute a
           WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped
         )
         AND has_table_privilege(current_user, c.oid, 'SELECT')
         AND (c.relrowsecurity IS FALSE OR c.relforcerowsecurity IS FALSE)
       ORDER BY c.relname`,
    );

    const row = role.rows[0];
    return {
      role: row?.role ?? 'unknown',
      isSuperuser: row?.is_superuser ?? false,
      bypassesRls: row?.bypasses_rls ?? false,
      unprotectedTables: unprotected.rows.map((r) => r.tablename),
    };
  } finally {
    client.release();
  }
}

export function assertRlsEnforced(result: RlsPreflightResult): void {
  const failures: string[] = [];

  if (result.isSuperuser) {
    failures.push(`the application role "${result.role}" is a superuser, which bypasses RLS`);
  }
  if (result.bypassesRls) {
    failures.push(`the application role "${result.role}" has BYPASSRLS`);
  }
  if (result.unprotectedTables.length > 0) {
    failures.push(
      `tenant tables without forced row-level security: ${result.unprotectedTables.join(', ')}`,
    );
  }

  if (failures.length > 0) {
    throw new Error(
      'Refusing to start: tenant isolation is not in force.\n' +
        failures.map((f) => `  - ${f}`).join('\n') +
        '\n  See db/roles.sql: the API connects as milyonuse_app, not as the owner.',
    );
  }
}
