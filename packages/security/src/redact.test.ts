import { describe, expect, it } from 'vitest';
import { REDACTED, redact, redactDeep, safeEnv } from './redact.js';

describe('redaction', () => {
  it('scrubs keys and tokens from text (Agent 5.5 test_redact_keys)', () => {
    const text = 'key sk-ant-abcdefghijklmnopqrstu and ghp_abcdefghijklmnopqrstuvwxyz and AKIAABCDEFGHIJKLMNOP';
    const out = redact(text);
    expect(out).not.toMatch(/sk-ant-|ghp_|AKIA/);
    expect(out.split(REDACTED)).toHaveLength(4);
  });

  it('scrubs bearer tokens, JWTs, Slack tokens, OpenRouter keys and private keys', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    for (const secret of [
      'Bearer abcdefghijklmnopqrstuvwx',
      jwt,
      'xoxb-1234567890-abcdefghij',
      'sk-or-v1-0123456789abcdef0123456789abcdef',
      '-----BEGIN PRIVATE KEY-----\nMIIBVQ==\n-----END PRIVATE KEY-----',
    ]) {
      expect(redact(`error: ${secret} rejected`), secret).toBe(`error: ${REDACTED} rejected`);
    }
  });

  it('keeps what a connection string was, without its password', () => {
    expect(redact('postgres://milyonuse:hunter2@db.example:5432/x')).toBe(`postgres://${REDACTED}@db.example:5432/x`);
  });

  it('leaves ordinary text alone', () => {
    const text = 'The skill set includes sketching and a token gesture of thanks.';
    expect(redact(text)).toBe(text);
  });

  it('redacts every string inside a structure, keeping its shape', () => {
    expect(redactDeep({ a: ['ghp_abcdefghijklmnopqrstuvwxyz', 3], b: { c: null } })).toEqual({ a: [REDACTED, 3], b: { c: null } });
  });
});

describe('a safe environment', () => {
  const base = { PATH: '/bin', HOME: '/h', OPENROUTER_API_KEY: 'x', DATABASE_URL: 'postgres://a:b@c/d', XDG_CACHE_HOME: '/c', SESSION_SECRET: 's' };

  it('keeps the allow-list and XDG_*, and strips everything else (test_safe_env_strips_secrets)', () => {
    expect(safeEnv(base)).toEqual({ PATH: '/bin', HOME: '/h', XDG_CACHE_HOME: '/c' });
  });

  it('passes a name the caller asks for, and a secret only when named exactly (test_safe_env_extra_allow)', () => {
    expect(safeEnv(base, ['DATABASE_URL'])).toMatchObject({ DATABASE_URL: 'postgres://a:b@c/d' });
    expect(safeEnv(base, ['OPENROUTER_API_KEY'])).toMatchObject({ OPENROUTER_API_KEY: 'x' });
    expect(safeEnv(base, ['DATABASE_URL'])).not.toHaveProperty('SESSION_SECRET');
  });
});
