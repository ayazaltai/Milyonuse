import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The tests find the database through one door (database.testing.ts here,
 * db/src/testing.ts for the schema's own suite), and turbo lets the three
 * per-role variables through to them. An address written into a test file
 * would ignore both: turbo's strict environment mode once dropped CI's
 * variables before the tests saw them, and 26 files that named 127.0.0.1:5432
 * themselves made it look as if they had arrived.
 */

const ROOT = join(__dirname, '../../../..');
const ROLE_VARIABLES = ['DATABASE_URL_APP', 'DATABASE_URL_PLATFORM', 'DATABASE_URL_MIGRATOR'];

function testFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) testFiles(path, found);
    else if (entry.name.endsWith('.test.ts')) found.push(path);
  }
  return found;
}

describe('where the tests find the database', () => {
  it('is never an address written into a test file', () => {
    // The suite's own database by name; an address made to fail — a closed
    // port, a database that does not exist — reaches nothing and may stay.
    const offenders = ['apps/api/src', 'db/src']
      .flatMap((dir) => testFiles(join(ROOT, dir)))
      .filter((file) =>
        /postgres(ql)?:\/\/[^'"`\s]*@[^'"`\s/]+\/milyonuse\b/.test(
          // A sample value handed to the env parser connects to nothing.
          file.endsWith('config/env.test.ts') ? '' : readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => file.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  it('reaches the tests through turbo, one variable per role', () => {
    const turbo = JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8')) as {
      tasks: Record<string, { env?: string[] }>;
    };
    expect(turbo.tasks['test']?.env ?? []).toEqual(expect.arrayContaining(ROLE_VARIABLES));
  });
});
