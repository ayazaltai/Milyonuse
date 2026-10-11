import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envSchema, loadEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgres://milyonuse_app:milyonuse@localhost:5432/milyonuse',
};

describe('loadEnv', () => {
  it('applies defaults for optional settings', () => {
    const env = loadEnv(valid as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.SESSION_COOKIE_NAME).toBe('mu_session');
    expect(env.SIGNUP_ENABLED).toBe(true);
  });

  it('fails loudly when a required variable is missing', () => {
    expect(() => loadEnv({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it('parses CORS origins into a list', () => {
    const env = loadEnv({
      ...valid,
      CORS_ORIGINS: 'https://milyonuse.com, https://www.milyonuse.com',
    } as NodeJS.ProcessEnv);
    expect(env.CORS_ORIGINS).toEqual(['https://milyonuse.com', 'https://www.milyonuse.com']);
  });

  it('closes registration only when told to', () => {
    expect(loadEnv({ ...valid, SIGNUP_ENABLED: 'false' } as NodeJS.ProcessEnv).SIGNUP_ENABLED).toBe(false);
    expect(loadEnv({ ...valid, SIGNUP_ENABLED: 'no' } as NodeJS.ProcessEnv).SIGNUP_ENABLED).toBe(true);
  });

  const production = {
    ...valid,
    NODE_ENV: 'production',
    DATABASE_URL_PLATFORM: 'postgres://milyonuse_platform:x@db/milyonuse',
    SECRETS_KEYS: `1:${'A'.repeat(43)}=`,
  };

  it('refuses production without the keys connection secrets are sealed with, and a local sandbox', () => {
    const ready = { ...production, MAIL_API_TOKEN: 'token' };
    expect(() => loadEnv({ ...ready, SECRETS_KEYS: '' } as NodeJS.ProcessEnv)).toThrow(/SECRETS_KEYS is required/);
    expect(() => loadEnv({ ...ready, SECRETS_KEYS: '1:short' } as NodeJS.ProcessEnv)).toThrow(/version:base64/);
    expect(() => loadEnv({ ...ready, SANDBOX_PROVIDER: 'local' } as NodeJS.ProcessEnv)).toThrow(/development only/);
    expect(loadEnv(ready as NodeJS.ProcessEnv).SANDBOX_PROVIDER).toBe('none');
  });

  it('refuses production without mail', () => {
    // Otherwise nobody could confirm an address or recover a password.
    expect(() => loadEnv(production as NodeJS.ProcessEnv)).toThrow(/SMTP_URL or MAIL_API_TOKEN is required/);
    expect(loadEnv({ ...production, MAIL_API_TOKEN: 'token' } as NodeJS.ProcessEnv).MAIL_API_BASE_URL).toBe(
      'https://api.mail.hostinger.com',
    );
  });

  it('refuses production without the platform role', () => {
    const { DATABASE_URL_PLATFORM: _omitted, ...rest } = production;
    expect(() => loadEnv({ ...rest, SMTP_URL: 'smtp://mail' } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL_PLATFORM is required/,
    );
  });

  it('refuses cron-driven workers that nothing could call', () => {
    const cron = { ...valid, WORKER_MODE: 'cron' };
    expect(() => loadEnv(cron as NodeJS.ProcessEnv)).toThrow(/CRON_SECRET/);
    expect(() => loadEnv({ ...cron, CRON_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow(/at least 32/);
    expect(loadEnv({ ...cron, CRON_SECRET: 'x'.repeat(32) } as NodeJS.ProcessEnv).WORKER_MODE).toBe('cron');
    expect(loadEnv(valid as NodeJS.ProcessEnv).WORKER_MODE).toBe('interval');
  });
});

/**
 * .env.example is the only list of settings a developer or an operator reads,
 * so it has to be the whole list and nothing but it. A variable the code reads
 * but the example omits is found in production, as a boot failure or a silent
 * default; one the example lists but nothing reads is a knob that does
 * nothing. Both directions are checked against the source itself.
 */
describe('.env.example', () => {
  const ROOT = join(__dirname, '../../../..');
  const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
  const documented = [...example.matchAll(/^#?[ \t]*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);

  /** Every non-test TypeScript file that could read the environment. */
  function sources(): string {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.next'].includes(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path);
      }
    };
    for (const dir of ['apps/api/src', 'apps/web', 'db/src']) walk(join(ROOT, dir));
    return files.map((f) => readFileSync(f, 'utf8')).join('\n');
  }

  const code = sources();
  /** Variables the shell scripts read, as `${NAME` or `${NAME:-default}`. */
  const readByScripts = new Set(
    readdirSync(join(ROOT, 'scripts'))
      .filter((f) => f.endsWith('.sh'))
      .flatMap((f) => [...readFileSync(join(ROOT, 'scripts', f), 'utf8').matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)])
      .map((m) => m[1]!),
  );
  const readDirectly = new Set(
    [...code.matchAll(/process\.env(?:\.|\[')([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!),
  );
  // Settings resolved by reference, as `PREFIX__${REF}`.
  const readByPrefix = [...code.matchAll(/`([A-Z][A-Z0-9_]*__)\$\{/g)].map((m) => m[1]!);

  it('finds what it is meant to check', () => {
    expect(documented).toContain('DATABASE_URL');
    expect(readDirectly).toContain('API_ORIGIN');
  });

  it('documents every variable the API validates', () => {
    const missing = Object.keys(envSchema.shape).filter((key) => !documented.includes(key));
    expect(missing).toEqual([]);
  });

  it('documents every variable read outside the API contract', () => {
    const missing = [...readDirectly].filter((key) => !documented.includes(key));
    expect(missing).toEqual([]);
  });

  it('lists nothing the code does not read', () => {
    const unread = documented.filter(
      (key) =>
        !(key in envSchema.shape) &&
        !readDirectly.has(key) &&
        !readByScripts.has(key) &&
        !readByPrefix.some((prefix) => key.startsWith(prefix)),
    );
    expect(unread).toEqual([]);
  });
});
