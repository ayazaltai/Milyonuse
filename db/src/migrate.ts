/**
 * Migration runner.
 *
 * Applies db/migrations/*.sql in filename order, once each, inside a
 * transaction, and records what it applied with a checksum. It is invoked as a
 * deliberate deploy step — never automatically at application startup, so that
 * a rolling restart can never half-migrate a live database.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function main(): Promise<void> {
  // Migrations run as the schema owner. DATABASE_URL_MIGRATOR names that
  // connection where DATABASE_URL belongs to the application role — a
  // developer's .env.local, where both live side by side. A deploy step that
  // sets only DATABASE_URL, pointed at the owner, works unchanged.
  const connectionString = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL_MIGRATOR (or DATABASE_URL) is not set');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString, max: 1 });
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text        NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>(
        'SELECT name, checksum FROM schema_migrations',
      )).rows.map((r) => [r.name, r.checksum]),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let pending = 0;

    for (const file of files) {
      const body = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex');
      const previous = applied.get(file);

      if (previous !== undefined) {
        if (previous !== checksum) {
          // An applied migration was edited. Rewriting history silently
          // desynchronises environments, so this stops the deploy.
          console.error(
            `\n  ✗ ${file} was modified after it was applied.\n` +
              `    Migrations are immutable once applied — add a new one instead.\n`,
          );
          process.exit(1);
        }
        continue;
      }

      process.stdout.write(`  → ${file} `);
      await client.query('BEGIN');
      try {
        await client.query(body);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
        pending += 1;
        process.stdout.write('applied\n');
      } catch (error) {
        await client.query('ROLLBACK');
        process.stdout.write('failed\n');
        throw error;
      }
    }

    console.log(pending === 0 ? '\nup to date' : `\n${pending} migration(s) applied`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
