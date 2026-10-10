import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { translateDatabaseError } from './database-error.js';

/**
 * Every rule the database enforces raises with a HINT, and every HINT needs a
 * place in the error contract — an unmapped one reaches the client as an
 * opaque 500 for what is really a domain refusal. Reading the hints out of the
 * migrations makes forgetting one a failing build rather than a support ticket.
 */
const MIGRATIONS = join(__dirname, '../../../../../db/migrations');

function hintsInMigrations(): string[] {
  const hints = new Set<string>();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    for (const match of sql.matchAll(/HINT\s*=\s*'([a-z_]+)'/g)) hints.add(match[1]!);
  }
  return [...hints].sort();
}

describe('database rule translation', () => {
  it('finds the hints it is meant to check', () => {
    expect(hintsInMigrations()).toContain('last_owner_protected');
    expect(hintsInMigrations()).toContain('audit_log_immutable');
  });

  it.each(hintsInMigrations())('maps %s to the error contract', (hint) => {
    expect(translateDatabaseError({ hint })).not.toBeNull();
  });
});
