import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { ErrorCode, PASSWORD_POLICY } from '@milyonuse/contracts';
import { AppError } from '../../common/app-error.js';

/**
 * Password digests.
 *
 * scrypt, from Node itself: no native dependency to build, which the
 * workspace's install policy deliberately refuses (pnpm-workspace.yaml,
 * allowBuilds). N = 2^15, r = 8, p = 3 is one of the equivalent settings OWASP
 * lists for scrypt — 32 MiB and a few hundred milliseconds a guess.
 *
 * The digest names its own parameters — scrypt$<log2 N>$<r>$<p>$<salt>$<key>,
 * salt and key in base64url — so a later, costlier setting is a change here:
 * a password stored under the old one still verifies, and is digested again
 * the next time its owner signs in (`needsRehash`). The database refuses any
 * other shape (0002, user_credentials_scrypt).
 */

export interface ScryptParameters {
  log2N: number;
  r: number;
  p: number;
}

export const CURRENT_PARAMETERS: ScryptParameters = { log2N: 15, r: 8, p: 3 };

const SALT_BYTES = 16;
const KEY_BYTES = 64;
const DIGEST = /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{32,})$/;

function derive(password: string, salt: Buffer, parameters: ScryptParameters, length: number): Promise<Buffer> {
  const N = 2 ** parameters.log2N;
  const options: ScryptOptions = {
    N,
    r: parameters.r,
    p: parameters.p,
    // scrypt needs 128·N·r bytes; Node's default ceiling (32 MiB) is exactly
    // that at the current setting and refuses it, so leave room.
    maxmem: 256 * N * parameters.r,
  };
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize('NFKC'), salt, length, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(
  password: string,
  parameters: ScryptParameters = CURRENT_PARAMETERS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, parameters, KEY_BYTES);
  return [
    'scrypt',
    parameters.log2N,
    parameters.r,
    parameters.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

function parse(digest: string): { parameters: ScryptParameters; salt: Buffer; key: Buffer } | null {
  const match = DIGEST.exec(digest);
  if (!match) return null;
  const [, log2N, r, p, salt, key] = match;
  const parameters = { log2N: Number(log2N), r: Number(r), p: Number(p) };
  // A digest is stored data: bound what it can make this process spend.
  if (parameters.log2N < 10 || parameters.log2N > 20 || parameters.r < 1 || parameters.r > 32) return null;
  if (parameters.p < 1 || parameters.p > 16) return null;
  return { parameters, salt: Buffer.from(salt!, 'base64url'), key: Buffer.from(key!, 'base64url') };
}

/** True when `password` produced `digest`. Compared in constant time. */
export async function verifyPassword(password: string, digest: string): Promise<boolean> {
  const parsed = parse(digest);
  if (!parsed) return false;
  const candidate = await derive(password, parsed.salt, parsed.parameters, parsed.key.length);
  return candidate.length === parsed.key.length && timingSafeEqual(candidate, parsed.key);
}

/** True when a digest was made with other parameters than today's, and should be made again. */
export function needsRehash(digest: string): boolean {
  const parsed = parse(digest);
  if (!parsed) return true;
  const { log2N, r, p } = parsed.parameters;
  return (
    log2N !== CURRENT_PARAMETERS.log2N ||
    r !== CURRENT_PARAMETERS.r ||
    p !== CURRENT_PARAMETERS.p ||
    parsed.key.length !== KEY_BYTES
  );
}

/**
 * A digest of no password anyone knows — random salt and key, made once and
 * kept as a constant, in today's parameters. Checking against it costs what a
 * real check costs, from the first call on: a decoy computed on demand would
 * make the first unknown address answer twice as slowly as a known one.
 */
export const DECOY_DIGEST =
  'scrypt$15$8$3$qAJmqqKLyfYY7Z9RM6y3qQ$LuwxjHraHT_UDEhntpNf9xhQWa2rg1CV2PEWHg6eUCLhCCXRcDQY5ukct94f5eqPpJjWYYYaaVrHNbHATJTB7w';

/**
 * Spends the time a real check would, for an address with no password. A
 * sign-in that answered faster for an unknown address would say which
 * addresses have accounts.
 */
export async function burnVerification(password: string): Promise<void> {
  await verifyPassword(password, DECOY_DIGEST);
}

/**
 * The passwords refused however long they are: the most common choices, which
 * are the first any guessing tries. Deliberately short — length does the rest.
 */
const COMMON = new Set([
  '1234567890',
  '0123456789',
  '12345678910',
  '1q2w3e4r5t',
  'qwertyuiop',
  'password123',
  'password1234',
  'passw0rd123',
  'iloveyou123',
  'qwerty12345',
  'qwerty123456',
  'abcdefghij',
  'abc1234567',
  'aaaaaaaaaa',
  '1111111111',
  'letmein123',
  'welcome123',
  'admin12345',
  'changeme123',
  'milyonus123',
  'milyonuse123',
  'milyonuse2026',
]);

/**
 * Refuses a password this product would not store: too short, too long, the
 * address itself, or one of the first a guesser tries. Worded for the field it
 * came from, the way a validation refusal is (common/filters).
 */
export function assertAcceptablePassword(password: string, email: string): void {
  const refuse = (message: string): never => {
    throw new AppError(ErrorCode.VALIDATION_FAILED, message, {
      details: [{ path: 'password', message }],
    });
  };

  if (password.length < PASSWORD_POLICY.minLength) {
    refuse(`Use at least ${PASSWORD_POLICY.minLength} characters.`);
  }
  if (password.length > PASSWORD_POLICY.maxLength) {
    refuse(`Use at most ${PASSWORD_POLICY.maxLength} characters.`);
  }

  const lowered = password.toLowerCase();
  const address = email.toLowerCase();
  const local = address.split('@')[0] ?? '';
  if (lowered === address || (local.length >= 4 && lowered.includes(local))) {
    refuse('Choose a password that does not contain your email address.');
  }
  if (COMMON.has(lowered) || new Set(lowered).size < 4) {
    refuse('That password is too easy to guess. Choose a longer or less common one.');
  }
}
