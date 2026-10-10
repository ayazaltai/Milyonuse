import { Inject, Injectable } from '@nestjs/common';
import { ACCOUNT_LINK_HOURS, ErrorCode, type Locale, type RegisterInput, isLocale } from '@milyonuse/contracts';
import type pg from 'pg';
import { AppError } from '../../common/app-error.js';
import { AppLogger } from '../../common/logging/logger.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { PLATFORM_POOL } from '../../database/database.module.js';
import { MAILER, type Mailer } from '../notifications/mail.port.js';
import { AuditService } from '../tenancy/audit.service.js';
import { rethrowDatabaseError } from '../tenancy/database-error.js';
import {
  alreadyRegisteredMail,
  noAccountMail,
  passwordChangedMail,
  passwordLinkMail,
  verifyMail,
} from './account-mail.js';
import { hashAccountToken, issueAccountToken } from './account-tokens.js';
import {
  assertAcceptablePassword,
  burnVerification,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password.js';
import { SessionService, type SignInContext } from './session.service.js';

/** What a mailed link is, when this deployment cannot mail it (development only). */
export interface DevelopmentLink {
  developmentLink?: string;
}

/** A session just opened, and the organization it opened in. */
export interface OpenedSession {
  token: string;
  expiresAt: Date;
  organizationId: string;
}

/** What waits in a verify_email link until the address is confirmed (0002). */
interface Registration {
  name: string;
  locale: Locale;
  timeZone: string;
  passwordHash: string;
  termsAcceptedAt: string;
}

/**
 * Accounts: registering, confirming the address, signing in with a password,
 * and setting one.
 *
 * Nothing exists under an address until someone who reads its inbox says so: a
 * registration waits in its link, with a digest of the password, and the
 * person, their personal organization, its owner membership and a session are
 * opened together when the link is followed (DECISIONS D-02).
 *
 * Registering or asking for a password link answers the same whatever the
 * address — what happened is said in the mail, to the address's owner — so
 * the API never confirms which addresses have accounts. A sign-in spends the
 * same time for an unknown address as for a known one, for the same reason.
 *
 * Everything here runs before a tenant is known, on the platform pool.
 */
@Injectable()
export class AccountService {
  constructor(
    @Inject(PLATFORM_POOL) private readonly platform: pg.Pool,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
  ) {}

  // ──────────────────────────────────────────────────────────────── register

  async register(input: RegisterInput): Promise<DevelopmentLink> {
    this.assertSignupOpen();
    assertAcceptablePassword(input.password, input.email);

    // Digested on every path, not only the one that keeps it: an answer that
    // came back sooner for a known address would say it is known.
    const passwordHash = await hashPassword(input.password);

    const { rows } = await this.platform.query<{ locale: string }>(
      `SELECT u.locale FROM users u JOIN user_credentials c ON c.user_id = u.id WHERE u.email = $1`,
      [input.email],
    );
    const existing = rows[0];
    if (existing) {
      const locale = isLocale(existing.locale) ? existing.locale : input.locale;
      await this.mailer.send(
        alreadyRegisteredMail(locale, input.email, this.url('/login'), this.url('/forgot')),
      );
      return {};
    }

    const registration: Registration = {
      name: input.name,
      locale: input.locale,
      timeZone: input.timeZone,
      passwordHash,
      termsAcceptedAt: new Date().toISOString(),
    };
    const token = await issueAccountToken(this.platform, {
      purpose: 'verify_email',
      email: input.email,
      userId: null,
      payload: { ...registration },
      hours: ACCOUNT_LINK_HOURS.verifyEmail,
    });

    const link = this.url(`/verify?token=${encodeURIComponent(token)}`);
    await this.mailer.send(verifyMail(input.locale, input.email, input.name, link));
    return this.development(link);
  }

  /**
   * Follows a registration's link: the person, their password, their personal
   * organization, its owner membership and a session — one transaction, the
   * link spent in it, so a second click opens nothing.
   */
  async verifyEmail(token: string, context: SignInContext): Promise<OpenedSession> {
    this.assertSignupOpen();

    const client = await this.platform.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query<{ email: string; payload: Registration }>(
        `DELETE FROM account_tokens
         WHERE token_hash = $1 AND purpose = 'verify_email' AND expires_at > now()
         RETURNING email, payload`,
        [hashAccountToken(token)],
      );
      const pending = rows[0];
      if (!pending) throw AccountService.invalidLink();
      const registration = pending.payload;

      const user = await client.query<{ id: string }>(
        `INSERT INTO users (email, name, locale, time_zone, email_verified_at, terms_accepted_at, last_seen_at)
         VALUES ($1, $2, $3, $4, now(), $5, now())
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [pending.email, registration.name, registration.locale, registration.timeZone, registration.termsAcceptedAt],
      );
      const userId = user.rows[0]?.id;
      if (!userId) {
        // The address was registered another way while this link waited.
        throw new AppError(
          ErrorCode.CONFLICT,
          'This address already has a Milyonuse account. Sign in, or reset your password.',
        );
      }

      await client.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`, [
        userId,
        registration.passwordHash,
      ]);

      const organization = await client.query<{ id: string }>(
        `INSERT INTO organizations (name, kind, owner_user_id) VALUES ($1, 'personal', $2) RETURNING id`,
        [registration.name, userId],
      );
      const organizationId = organization.rows[0]!.id;

      const member = await client.query<{ id: string }>(
        `INSERT INTO members (organization_id, user_id, role) VALUES ($1, $2, 'owner') RETURNING id`,
        [organizationId, userId],
      );
      const memberId = member.rows[0]!.id;

      await this.audit.record(client, {
        organizationId,
        actorMemberId: memberId,
        action: 'account.registered',
        resourceType: 'user',
        resourceId: userId,
        after: { locale: registration.locale, timeZone: registration.timeZone },
        ip: context.ip,
        userAgent: context.userAgent,
      });

      const session = await this.sessions.create({ organizationId, userId, memberId, ...context }, client);
      await client.query('COMMIT');
      return { ...session, organizationId };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof AppError) throw error;
      rethrowDatabaseError(error);
    } finally {
      client.release();
    }
  }

  // ───────────────────────────────────────────────────────────────── sign in

  async signIn(email: string, password: string, context: SignInContext): Promise<OpenedSession> {
    const { rows } = await this.platform.query<{ id: string; password_hash: string }>(
      `SELECT u.id, c.password_hash
       FROM users u JOIN user_credentials c ON c.user_id = u.id
       WHERE u.email = $1`,
      [email],
    );
    const account = rows[0];

    if (!account) {
      await burnVerification(password);
      throw AccountService.invalidCredentials();
    }
    if (!(await verifyPassword(password, account.password_hash))) {
      this.logger.warn('password sign-in refused', { reason: 'wrong_password' });
      throw AccountService.invalidCredentials();
    }

    if (needsRehash(account.password_hash)) {
      await this.platform.query(`UPDATE user_credentials SET password_hash = $2 WHERE user_id = $1`, [
        account.id,
        await hashPassword(password),
      ]);
    }
    await this.platform.query(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [account.id]);

    // A person signs in to their personal organization. Shared organizations
    // (Phase 9) are switched to from inside the app.
    const membership = await this.platform.query<{ organization_id: string; member_id: string }>(
      `SELECT o.id AS organization_id, m.id AS member_id
         FROM organizations o
         JOIN members m ON m.organization_id = o.id AND m.user_id = o.owner_user_id
        WHERE o.owner_user_id = $1 AND o.kind = 'personal'
          AND o.status = 'active' AND m.status = 'active'`,
      [account.id],
    );
    const target = membership.rows[0];
    if (!target) {
      throw new AppError(ErrorCode.ORGANIZATION_SUSPENDED, 'This account is not active. Contact support.');
    }

    const session = await this.sessions.create({
      organizationId: target.organization_id,
      userId: account.id,
      memberId: target.member_id,
      ...context,
    });
    return { ...session, organizationId: target.organization_id };
  }

  // ──────────────────────────────────────────────────────────────── password

  /**
   * Mails a link to set a new password. An address with no account is told
   * so, in the same kind of mail; the answer to the caller is the same.
   */
  async requestPasswordLink(email: string, requestLocale: Locale): Promise<DevelopmentLink> {
    const { rows } = await this.platform.query<{ id: string; locale: string }>(
      `SELECT id, locale FROM users WHERE email = $1`,
      [email],
    );
    const user = rows[0];
    if (!user) {
      await this.mailer.send(noAccountMail(requestLocale, email, this.url('/register')));
      return {};
    }

    const token = await issueAccountToken(this.platform, {
      purpose: 'set_password',
      email,
      userId: user.id,
      hours: ACCOUNT_LINK_HOURS.setPassword,
    });
    const link = this.url(`/reset?token=${encodeURIComponent(token)}`);
    await this.mailer.send(passwordLinkMail(isLocale(user.locale) ? user.locale : requestLocale, email, link));
    return this.development(link);
  }

  /**
   * Sets the password a link was issued for. Every session the person has
   * ends: whoever changed a password because someone else knew it wants that
   * someone out.
   */
  async resetPassword(token: string, password: string, context: SignInContext): Promise<{ email: string }> {
    // Read first, spent after: a password refused for being weak must leave
    // the link usable for a better one.
    const { rows: waiting } = await this.platform.query<{ email: string }>(
      `SELECT email FROM account_tokens
       WHERE token_hash = $1 AND purpose = 'set_password' AND expires_at > now()`,
      [hashAccountToken(token)],
    );
    if (!waiting[0]) throw AccountService.invalidLink();
    assertAcceptablePassword(password, waiting[0].email);
    const passwordHash = await hashPassword(password);

    const client = await this.platform.connect();
    let changed: { userId: string; email: string; locale: Locale };
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ user_id: string; email: string }>(
        `DELETE FROM account_tokens
         WHERE token_hash = $1 AND purpose = 'set_password' AND expires_at > now()
         RETURNING user_id, email`,
        [hashAccountToken(token)],
      );
      const link = rows[0];
      if (!link) throw AccountService.invalidLink();

      await client.query(
        `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE
           SET password_hash = EXCLUDED.password_hash, password_changed_at = now()`,
        [link.user_id, passwordHash],
      );
      await client.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_reset'
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [link.user_id],
      );
      const locale = await this.recordPasswordChange(client, link.user_id, 'user.password_reset', context);
      changed = { userId: link.user_id, email: link.email, locale };

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof AppError) throw error;
      rethrowDatabaseError(error);
    } finally {
      client.release();
    }

    await this.notifyPasswordChanged(changed.locale, changed.email);
    return { email: changed.email };
  }

  /**
   * Changes the password of someone signed in, who proves they know the
   * current one. Every other session ends; this one stays.
   */
  async changePassword(
    input: { userId: string; currentSessionId: string; currentPassword: string; newPassword: string },
    context: SignInContext,
  ): Promise<void> {
    const { rows } = await this.platform.query<{ email: string; password_hash: string }>(
      `SELECT u.email, c.password_hash FROM users u JOIN user_credentials c ON c.user_id = u.id WHERE u.id = $1`,
      [input.userId],
    );
    const account = rows[0];
    if (!account || !(await verifyPassword(input.currentPassword, account.password_hash))) {
      throw new AppError(ErrorCode.REAUTHENTICATION_FAILED, 'Your current password is not correct.', {
        details: [{ path: 'currentPassword', message: 'Your current password is not correct.' }],
      });
    }
    assertAcceptablePassword(input.newPassword, account.email);
    const passwordHash = await hashPassword(input.newPassword);

    const client = await this.platform.connect();
    let locale: Locale;
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE user_credentials SET password_hash = $2, password_changed_at = now() WHERE user_id = $1`,
        [input.userId, passwordHash],
      );
      await client.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_changed'
         WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2`,
        [input.userId, input.currentSessionId],
      );
      locale = await this.recordPasswordChange(client, input.userId, 'user.password_changed', context);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      rethrowDatabaseError(error);
    } finally {
      client.release();
    }

    await this.notifyPasswordChanged(locale, account.email);
  }

  // ─────────────────────────────────────────────────────────────── internals

  /**
   * On the record of every organization the person belongs to: whose account
   * changed hands is each of their owners' business. Returns their language.
   */
  private async recordPasswordChange(
    client: pg.PoolClient,
    userId: string,
    action: 'user.password_reset' | 'user.password_changed',
    context: SignInContext,
  ): Promise<Locale> {
    const { rows } = await client.query<{ id: string; organization_id: string; locale: string }>(
      `SELECT m.id, m.organization_id, u.locale
         FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.user_id = $1 AND m.status = 'active'`,
      [userId],
    );
    for (const member of rows) {
      await this.audit.record(client, {
        organizationId: member.organization_id,
        actorMemberId: member.id,
        action,
        resourceType: 'user',
        resourceId: userId,
        ip: context.ip,
        userAgent: context.userAgent,
      });
    }
    const locale = rows[0]?.locale;
    return isLocale(locale) ? locale : 'en';
  }

  /** The password has changed whatever happens to this mail; a transport failure is logged, not thrown. */
  private async notifyPasswordChanged(locale: Locale, email: string): Promise<void> {
    await this.mailer
      .send(passwordChangedMail(locale, email, this.url('/forgot')))
      .catch((error: unknown) =>
        this.logger.error('password-changed notice not sent', {
          err: error instanceof Error ? error.message : String(error),
        }),
      );
  }

  private assertSignupOpen(): void {
    if (!this.env.SIGNUP_ENABLED) {
      throw new AppError(ErrorCode.SIGNUP_CLOSED, 'Registration is closed for now. Try again soon.');
    }
  }

  private url(path: string): string {
    return new URL(path, this.env.APP_BASE_URL).toString();
  }

  /**
   * The link itself, handed back only while mail goes to the log — a mailer
   * that refuses to exist in production — so a developer can follow a
   * registration through without a mail server.
   */
  private development(link: string): DevelopmentLink {
    return this.mailer.name === 'logging' ? { developmentLink: link } : {};
  }

  private static invalidLink(): AppError {
    // One answer for unknown, used and expired alike: telling them apart would
    // say which links ever existed.
    return new AppError(ErrorCode.NOT_FOUND, 'This link is no longer valid. Ask for a new one.');
  }

  private static invalidCredentials(): AppError {
    return new AppError(ErrorCode.INVALID_CREDENTIALS, 'That email and password do not match an account.');
  }
}
