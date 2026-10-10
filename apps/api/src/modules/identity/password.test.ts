import { describe, expect, it } from 'vitest';
import { AppError } from '../../common/app-error.js';
import {
  CURRENT_PARAMETERS,
  DECOY_DIGEST,
  assertAcceptablePassword,
  burnVerification,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password.js';

/** The shape 0002 accepts; the test keeps the two from drifting apart. */
const STORED = /^scrypt\$[0-9]{1,2}\$[0-9]{1,2}\$[0-9]{1,2}\$[A-Za-z0-9_-]{16,}\$[A-Za-z0-9_-]{32,}$/;

describe('password digests', () => {
  it('verifies the password that made a digest, and no other', async () => {
    const digest = await hashPassword('a long enough secret');
    expect(digest).toMatch(STORED);
    expect(digest.startsWith(`scrypt$${CURRENT_PARAMETERS.log2N}$${CURRENT_PARAMETERS.r}$${CURRENT_PARAMETERS.p}$`)).toBe(
      true,
    );
    expect(await verifyPassword('a long enough secret', digest)).toBe(true);
    expect(await verifyPassword('a long enough secreT', digest)).toBe(false);
    expect(await verifyPassword('', digest)).toBe(false);
  });

  it('salts every digest, so one password never gives the same one twice', async () => {
    const [a, b] = await Promise.all([hashPassword('same password here'), hashPassword('same password here')]);
    expect(a).not.toBe(b);
  });

  it('keeps an older setting working, and asks for it to be digested again', async () => {
    const older = await hashPassword('rotated parameters', { log2N: 14, r: 8, p: 1 });
    expect(await verifyPassword('rotated parameters', older)).toBe(true);
    expect(needsRehash(older)).toBe(true);
    expect(needsRehash(await hashPassword('rotated parameters'))).toBe(false);
  });

  it('refuses what is not a digest, and parameters that would cost too much to check', async () => {
    expect(await verifyPassword('anything', 'plain text')).toBe(false);
    expect(await verifyPassword('anything', 'scrypt$30$8$1$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86))).toBe(false);
    expect(needsRehash('plain text')).toBe(true);
  });

  it('checks an address with no password against a decoy that costs what a real check does', async () => {
    // A decoy that failed to parse, or used an older setting, would be cheaper
    // to check — and an unknown address would answer faster than a known one.
    expect(DECOY_DIGEST).toMatch(STORED);
    expect(needsRehash(DECOY_DIGEST)).toBe(false);
    await expect(burnVerification('any guess at all')).resolves.toBeUndefined();
  });

  it('reads a password the same whichever way its accents were typed', async () => {
    // "é" as one code point, and as "e" followed by a combining accent.
    const digest = await hashPassword('café au lait 42');
    expect(await verifyPassword('café au lait 42', digest)).toBe(true);
  });
});

describe('the password policy', () => {
  const refused = (password: string, email = 'ada@acme.test'): string | null => {
    try {
      assertAcceptablePassword(password, email);
      return null;
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('validation_failed');
      expect(appError.details?.[0]?.path).toBe('password');
      return appError.message;
    }
  };

  it('takes a long, unremarkable password', () => {
    expect(refused('violet-harbour-lantern')).toBeNull();
  });

  it('refuses one that is short, the address, or among the first a guesser tries', () => {
    expect(refused('short1')).toMatch(/at least 10/);
    expect(refused('x'.repeat(129))).toMatch(/at most 128/);
    expect(refused('ada@acme.test')).toMatch(/email address/);
    expect(refused('lovelace-2026', 'lovelace@acme.test')).toMatch(/email address/);
    expect(refused('Password123')).toMatch(/too easy/);
    expect(refused('ababababababab')).toMatch(/too easy/);
  });
});
