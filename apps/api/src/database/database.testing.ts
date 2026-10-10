/**
 * Where the tests find the database: one connection per role (db/roles.sql),
 * each read from its own variable, so CI — or a run against another cluster —
 * moves every test at once. turbo.json passes exactly these to the test task.
 *
 * Never DATABASE_URL: CI and .env files point it at whichever role their own
 * process serves (CI's is the schema owner), and the e2e suites set it to the
 * application role for the API they start.
 */

export const APP_URL =
  process.env['DATABASE_URL_APP'] ?? 'postgres://milyonuse_app:milyonuse@127.0.0.1:5432/milyonuse';

export const PLATFORM_URL =
  process.env['DATABASE_URL_PLATFORM'] ??
  'postgres://milyonuse_platform:milyonuse@127.0.0.1:5432/milyonuse';

/** The schema owner — only for what a migration would do. */
export const OWNER_URL =
  process.env['DATABASE_URL_MIGRATOR'] ?? 'postgres://milyonuse:milyonuse@127.0.0.1:5432/milyonuse';
