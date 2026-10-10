import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode, SESSION_POLICY, type SessionSummary } from '@milyonuse/contracts';
import type pg from 'pg';
import { AppError } from '../../common/app-error.js';
import { PLATFORM_POOL } from '../../database/database.module.js';
import { AuditService } from '../tenancy/audit.service.js';
import { TenantScope } from '../tenancy/tenant-scope.service.js';

export interface ResolvedSession {
  sessionId: string;
  organizationId: string;
  userId: string;
  memberId: string;
  authenticatedAt: Date;
  expiresAt: Date;
}

/** Where a sign-in came from — kept on the session and in the audit log. */
export interface SignInContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export type RevokeReason =
  | 'sign_out'
  | 'idle_timeout'
  | 'password_reset'
  | 'password_changed'
  | 'revoked_by_user'
  | 'member_deactivated';

const DAY_MS = 86_400_000;

/** How stale a session's activity mark may get before a request refreshes it. */
const TOUCH_INTERVAL_MS = 60_000;

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Server-side sessions (0003).
 *
 * The cookie carries a random 256-bit token; the database stores only its
 * SHA-256, so a copy of the table opens nothing. Lifetimes are the product's
 * (SESSION_POLICY): a week without use ends a session, a month ends it
 * whatever happens.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(PLATFORM_POOL) private readonly platform: pg.Pool,
    private readonly scope: TenantScope,
    private readonly audit: AuditService,
  ) {}

  /**
   * Issues a session and returns the plaintext token — the only time it
   * exists. Takes the transaction it is opened in when there is one (a
   * registration opens the account and the session together); otherwise opens
   * its own scope.
   */
  async create(
    input: { organizationId: string; userId: string; memberId: string } & SignInContext,
    client?: pg.PoolClient,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_POLICY.absoluteDays * DAY_MS);

    const write = async (db: pg.PoolClient): Promise<void> => {
      await db.query(
        `INSERT INTO sessions (organization_id, user_id, member_id, token_hash, expires_at, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.organizationId,
          input.userId,
          input.memberId,
          hashSessionToken(token),
          expiresAt,
          input.ip ?? null,
          input.userAgent?.slice(0, 512) ?? null,
        ],
      );
      await this.audit.record(db, {
        organizationId: input.organizationId,
        actorMemberId: input.memberId,
        action: 'session.created',
        resourceType: 'session',
        ip: input.ip,
        userAgent: input.userAgent,
      });
    };

    if (client) await write(client);
    else await this.scope.run(input.organizationId, write);
    return { token, expiresAt };
  }

  /**
   * Resolves a cookie token into a session, or throws.
   *
   * This is the one query that cannot be tenant-scoped: which tenant the caller
   * belongs to is exactly what it determines. It runs on the platform pool,
   * reads a single row by token hash, and everything after it is scoped to the
   * organization it returns.
   */
  async resolve(token: string): Promise<ResolvedSession> {
    const hash = hashSessionToken(token);
    const { rows } = await this.platform.query<{
      id: string;
      organization_id: string;
      user_id: string;
      member_id: string;
      token_hash: string;
      authenticated_at: Date;
      last_seen_at: Date;
      expires_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT id, organization_id, user_id, member_id, token_hash,
              authenticated_at, last_seen_at, expires_at, revoked_at
         FROM sessions
        WHERE token_hash = $1`,
      [hash],
    );

    const row = rows[0];
    // Constant-time even though the lookup was by hash: the row is only reached
    // by an exact match, and comparing again costs nothing.
    if (!row || !timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(hash, 'hex'))) {
      throw new AppError(ErrorCode.SESSION_EXPIRED, 'Your session is no longer valid.');
    }
    if (row.revoked_at) {
      throw new AppError(ErrorCode.SESSION_EXPIRED, 'This session was signed out.');
    }
    if (row.expires_at.getTime() <= Date.now()) {
      throw new AppError(ErrorCode.SESSION_EXPIRED, 'Your session has expired.');
    }

    const idleMs = Date.now() - row.last_seen_at.getTime();
    if (idleMs > SESSION_POLICY.idleDays * DAY_MS) {
      await this.revoke(row.organization_id, row.id, 'idle_timeout');
      throw new AppError(ErrorCode.SESSION_EXPIRED, 'Your session timed out.');
    }

    // Sliding activity window, at most once a minute: a finer mark changes
    // nothing for a timeout counted in days but costs a write per request.
    if (idleMs >= TOUCH_INTERVAL_MS) {
      await this.platform.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [row.id]);
    }

    return {
      sessionId: row.id,
      organizationId: row.organization_id,
      userId: row.user_id,
      memberId: row.member_id,
      authenticatedAt: row.authenticated_at,
      expiresAt: row.expires_at,
    };
  }

  async revoke(organizationId: string, sessionId: string, reason: RevokeReason): Promise<boolean> {
    return this.scope.run(organizationId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
         WHERE id = $1 AND revoked_at IS NULL`,
        [sessionId, reason],
      );
      return (rowCount ?? 0) > 0;
    });
  }

  /** A person's live sessions in this organization, newest activity first. */
  async list(organizationId: string, memberId: string, currentSessionId: string): Promise<SessionSummary[]> {
    return this.scope.run(organizationId, async (client) => {
      const { rows } = await client.query<{
        id: string;
        created_at: Date;
        last_seen_at: Date;
        expires_at: Date;
        ip: string | null;
        user_agent: string | null;
      }>(
        `SELECT id, created_at, last_seen_at, expires_at, host(ip) AS ip, user_agent
           FROM sessions
          WHERE member_id = $1 AND revoked_at IS NULL AND expires_at > now()
          ORDER BY last_seen_at DESC
          LIMIT 50`,
        [memberId],
      );
      return rows.map((r) => ({
        id: r.id,
        current: r.id === currentSessionId,
        createdAt: r.created_at.toISOString(),
        lastSeenAt: r.last_seen_at.toISOString(),
        expiresAt: r.expires_at.toISOString(),
        ip: r.ip,
        userAgent: r.user_agent,
      }));
    });
  }

  /** Deletes sessions that ended more than a week ago. Returns how many went. Run by the hourly pass. */
  async purgeEnded(): Promise<number> {
    const { rowCount } = await this.platform.query(
      `DELETE FROM sessions
        WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')
           OR expires_at < now() - interval '7 days'`,
    );
    return rowCount ?? 0;
  }
}
