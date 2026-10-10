import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

/**
 * The one-time links an account mail carries (0002, account_tokens).
 *
 * 256 random bits in the link; only their SHA-256 in the database, so a copy of
 * it opens nothing. One open link per person and purpose: asking again
 * replaces the last one, and the old link stops working the moment the new one
 * is issued.
 */

export type AccountTokenPurpose = 'verify_email' | 'set_password';

export function hashAccountToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function issueAccountToken(
  db: pg.Pool | pg.PoolClient,
  input: {
    purpose: AccountTokenPurpose;
    email: string;
    userId: string | null;
    payload?: Record<string, unknown> | undefined;
    hours: number;
  },
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO account_tokens (purpose, email, user_id, token_hash, payload, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))
     ON CONFLICT (purpose, email) DO UPDATE
       SET user_id    = EXCLUDED.user_id,
           token_hash = EXCLUDED.token_hash,
           payload    = EXCLUDED.payload,
           issued_at  = EXCLUDED.issued_at,
           expires_at = EXCLUDED.expires_at`,
    [
      input.purpose,
      input.email,
      input.userId,
      hashAccountToken(token),
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.hours,
    ],
  );
  return token;
}

/** Deletes links whose time is up. Returns how many went. Run by the hourly pass. */
export async function purgeExpiredAccountTokens(platform: pg.Pool): Promise<number> {
  const { rowCount } = await platform.query(`DELETE FROM account_tokens WHERE expires_at <= now()`);
  return rowCount ?? 0;
}
