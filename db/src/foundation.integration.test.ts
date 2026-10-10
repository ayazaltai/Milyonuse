import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { APP_URL, OWNER_URL, PLATFORM_URL, asTenant, hintOf } from './testing.js';

/**
 * The rules the foundation migrations (0001–0005) enforce, tested where they
 * live: in the database, as each role that will meet them.
 */

const app = new pg.Pool({ connectionString: APP_URL, max: 3 });
const platform = new pg.Pool({ connectionString: PLATFORM_URL, max: 3 });
const owner = new pg.Pool({ connectionString: OWNER_URL, max: 2 });
const suffix = Date.now().toString(36);

interface Account {
  userId: string;
  organizationId: string;
  memberId: string;
}

const PASSWORD_HASH =
  'scrypt$15$8$3$qAJmqqKLyfYY7Z9RM6y3qQ$LuwxjHraHT_UDEhntpNf9xhQWa2rg1CV2PEWHg6eUCLhCCXRcDQY5ukct94f5eqPpJjWYYYaaVrHNbHATJTB7w';

/** What registration does (AccountService.verifyEmail), on the platform role. */
async function openAccount(name: string): Promise<Account> {
  const client = await platform.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
      [`${name}-${suffix}@foundation.test`, name],
    );
    const userId = user.rows[0]!.id;
    await client.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`, [userId, PASSWORD_HASH]);
    const org = await client.query<{ id: string }>(
      `INSERT INTO organizations (name, kind, owner_user_id) VALUES ($1, 'personal', $2) RETURNING id`,
      [name, userId],
    );
    const organizationId = org.rows[0]!.id;
    const member = await client.query<{ id: string }>(
      `INSERT INTO members (organization_id, user_id, role) VALUES ($1, $2, 'owner') RETURNING id`,
      [organizationId, userId],
    );
    await client.query('COMMIT');
    return { userId, organizationId, memberId: member.rows[0]!.id };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

let ada: Account;
let grace: Account;

beforeAll(async () => {
  ada = await openAccount('ada');
  grace = await openAccount('grace');
});

afterAll(async () => {
  await platform.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${suffix}@foundation.test`]);
  await Promise.all([app.end(), platform.end(), owner.end()]);
});

describe('tenant isolation', () => {
  it('shows a tenant its own rows and nobody else’s', async () => {
    const seen = await asTenant(app, ada.organizationId, async (c) => ({
      organizations: (await c.query<{ id: string }>(`SELECT id FROM organizations`)).rows.map((r) => r.id),
      members: (await c.query<{ id: string }>(`SELECT id FROM members`)).rows.map((r) => r.id),
      users: (await c.query<{ id: string }>(`SELECT id FROM users`)).rows.map((r) => r.id),
    }));
    expect(seen).toEqual({ organizations: [ada.organizationId], members: [ada.memberId], users: [ada.userId] });
  });

  it('shows nothing at all without a scope', async () => {
    const { rows } = await app.query(`SELECT 1 FROM organizations UNION ALL SELECT 1 FROM users`);
    expect(rows).toHaveLength(0);
  });

  it('binds the schema owner too (FORCE)', async () => {
    const { rows } = await owner.query(`SELECT 1 FROM members WHERE id = $1`, [ada.memberId]);
    expect(rows).toHaveLength(0);
  });

  it('cannot write into another tenant', async () => {
    await expect(
      asTenant(app, ada.organizationId, (c) =>
        c.query(`INSERT INTO audit_log (organization_id, actor_type, action, resource_type) VALUES ($1, 'system', 'x.y', 'x')`, [
          grace.organizationId,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('keeps passwords and account links out of the application role’s reach', async () => {
    await expect(app.query(`SELECT 1 FROM user_credentials`)).rejects.toThrow(/permission denied/);
    await expect(app.query(`SELECT 1 FROM account_tokens`)).rejects.toThrow(/permission denied/);
    await expect(app.query(`SELECT 1 FROM rate_limit_windows`)).rejects.toThrow(/permission denied/);
  });
});

describe('identity rules', () => {
  it('stores only a scrypt digest as a password', async () => {
    const error = await platform
      .query(`UPDATE user_credentials SET password_hash = 'hunter2' WHERE user_id = $1`, [ada.userId])
      .catch((e: unknown) => e);
    expect((error as { constraint?: string }).constraint).toBe('user_credentials_scrypt');
  });

  it('gives a person one personal workspace', async () => {
    const error = await platform
      .query(`INSERT INTO organizations (name, kind, owner_user_id) VALUES ('second', 'personal', $1)`, [ada.userId])
      .catch((e: unknown) => e);
    expect((error as { constraint?: string }).constraint).toBe('organizations_one_personal');
  });

  it('lets nobody else into a personal workspace', async () => {
    const error = await platform
      .query(`INSERT INTO members (organization_id, user_id, role) VALUES ($1, $2, 'member')`, [
        ada.organizationId,
        grace.userId,
      ])
      .catch((e: unknown) => e);
    expect(hintOf(error)).toBe('personal_organization_single_member');
  });

  it('keeps the last active owner', async () => {
    const error = await asTenant(app, ada.organizationId, (c) =>
      c.query(`UPDATE members SET status = 'deactivated', deactivated_at = now() WHERE id = $1`, [ada.memberId]),
    ).catch((e: unknown) => e);
    expect(hintOf(error)).toBe('last_owner_protected');
  });

  it('refuses a time zone Postgres does not know', async () => {
    const error = await asTenant(app, ada.organizationId, (c) =>
      c.query(`UPDATE users SET time_zone = 'Mars/Olympus_Mons' WHERE id = $1`, [ada.userId]),
    ).catch((e: unknown) => e);
    expect(hintOf(error)).toBe('time_zone_unknown');
  });

  it('never changes what an organization is', async () => {
    const error = await asTenant(app, ada.organizationId, (c) =>
      c.query(`UPDATE organizations SET kind = 'shared' WHERE id = $1`, [ada.organizationId]),
    ).catch((e: unknown) => e);
    expect(hintOf(error)).toBe('organization_identity_fixed');
  });

  it('keeps an account link short-lived and free of passwords', async () => {
    const tooLong = await platform
      .query(
        `INSERT INTO account_tokens (purpose, email, user_id, token_hash, expires_at)
         VALUES ('set_password', $1, $2, repeat('a', 64), now() + interval '3 hours')`,
        [`ada-${suffix}@foundation.test`, ada.userId],
      )
      .catch((e: unknown) => e);
    expect((tooLong as { constraint?: string }).constraint).toBe('account_tokens_short_lived');

    const withPassword = await platform
      .query(
        `INSERT INTO account_tokens (purpose, email, token_hash, payload, expires_at)
         VALUES ('verify_email', $1, repeat('b', 64), $2, now() + interval '1 hour')`,
        [`new-${suffix}@foundation.test`, JSON.stringify({ passwordHash: PASSWORD_HASH, password: 'plain' })],
      )
      .catch((e: unknown) => e);
    expect((withPassword as { constraint?: string }).constraint).toBe('account_tokens_no_password');
  });
});

describe('sessions', () => {
  it('cannot name a member of another tenant', async () => {
    const error = await platform
      .query(
        `INSERT INTO sessions (organization_id, user_id, member_id, token_hash, expires_at)
         VALUES ($1, $2, $3, repeat('c', 64), now() + interval '1 day')`,
        [ada.organizationId, grace.userId, grace.memberId],
      )
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('23503');
  });

  it('is seen or ended, and an ended session stays ended', async () => {
    const { rows } = await platform.query<{ id: string }>(
      `INSERT INTO sessions (organization_id, user_id, member_id, token_hash, expires_at)
       VALUES ($1, $2, $3, repeat('d', 64), now() + interval '1 day') RETURNING id`,
      [ada.organizationId, ada.userId, ada.memberId],
    );
    const id = rows[0]!.id;
    await asTenant(app, ada.organizationId, (c) =>
      c.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'sign_out' WHERE id = $1`, [id]),
    );
    const error = await asTenant(app, ada.organizationId, (c) =>
      c.query(`UPDATE sessions SET revoked_at = NULL, revoked_reason = NULL WHERE id = $1`, [id]),
    ).catch((e: unknown) => e);
    expect(hintOf(error)).toBe('session_fixed');
  });

  it('lives at most ninety days', async () => {
    const error = await platform
      .query(
        `INSERT INTO sessions (organization_id, user_id, member_id, token_hash, expires_at)
         VALUES ($1, $2, $3, repeat('e', 64), now() + interval '120 days')`,
        [ada.organizationId, ada.userId, ada.memberId],
      )
      .catch((e: unknown) => e);
    expect((error as { constraint?: string }).constraint).toBe('sessions_lifetime');
  });
});

describe('the audit log', () => {
  it('is append-only, for the application role and the platform role alike', async () => {
    const { rows } = await asTenant(app, ada.organizationId, (c) =>
      c.query<{ id: string }>(
        `INSERT INTO audit_log (organization_id, actor_member_id, action, resource_type)
         VALUES ($1, $2, 'test.written', 'test') RETURNING id`,
        [ada.organizationId, ada.memberId],
      ),
    );
    const id = rows[0]!.id;
    await expect(
      asTenant(app, ada.organizationId, (c) => c.query(`UPDATE audit_log SET action = 'test.rewritten' WHERE id = $1`, [id])),
    ).rejects.toThrow(/permission denied/);
    const error = await platform.query(`DELETE FROM audit_log WHERE id = $1`, [id]).catch((e: unknown) => e);
    expect(hintOf(error)).toBe('audit_log_immutable');
  });

  it('names a member when the actor is one', async () => {
    const error = await asTenant(app, ada.organizationId, (c) =>
      c.query(`INSERT INTO audit_log (organization_id, action, resource_type) VALUES ($1, 'test.anonymous', 'test')`, [
        ada.organizationId,
      ]),
    ).catch((e: unknown) => e);
    expect((error as { constraint?: string }).constraint).toBe('audit_log_member_actor');
  });
});

describe('the queue', () => {
  it('runs the same work once, and a finished job stays finished', async () => {
    const insert = () =>
      asTenant(app, ada.organizationId, (c) =>
        c.query(
          `INSERT INTO jobs (organization_id, kind, dedupe_key) VALUES ($1, 'test_kind', $2)
           ON CONFLICT (organization_id, dedupe_key) DO NOTHING RETURNING id`,
          [ada.organizationId, `once-${suffix}`],
        ),
      );
    const first = await insert();
    const second = await insert();
    expect(first.rowCount).toBe(1);
    expect(second.rowCount).toBe(0);

    const id = (first.rows[0] as { id: string }).id;
    await platform.query(`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = $1`, [id]);
    const error = await platform
      .query(`UPDATE jobs SET status = 'queued', finished_at = NULL WHERE id = $1`, [id])
      .catch((e: unknown) => e);
    expect(hintOf(error)).toBe('job_finished');
  });

  it('refuses a kind that is not a name', async () => {
    const error = await asTenant(app, ada.organizationId, (c) =>
      c.query(`INSERT INTO jobs (organization_id, kind, dedupe_key) VALUES ($1, 'Drop Table', 'k')`, [ada.organizationId]),
    ).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('23514');
  });
});

describe('erasing an account', () => {
  it('takes the person’s workspace and everything in it, audit trail included', async () => {
    const leaving = await openAccount('leaving');
    await asTenant(app, leaving.organizationId, (c) =>
      c.query(`INSERT INTO audit_log (organization_id, actor_member_id, action, resource_type) VALUES ($1, $2, 'test.kept', 'test')`, [
        leaving.organizationId,
        leaving.memberId,
      ]),
    );
    await platform.query(`DELETE FROM users WHERE id = $1`, [leaving.userId]);
    const left = await platform.query(
      `SELECT (SELECT count(*) FROM organizations WHERE id = $1) + (SELECT count(*) FROM audit_log WHERE organization_id = $1) AS n`,
      [leaving.organizationId],
    );
    expect(Number((left.rows[0] as { n: string }).n)).toBe(0);
  });
});
