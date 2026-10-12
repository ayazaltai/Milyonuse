import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { APP_URL, PLATFORM_URL, asTenant, hintOf } from './testing.js';

/**
 * The rules 0014_channels enforces: a pairing code lives an hour, is used
 * once and is replaced by a newer one; five wrong codes lock an identity; an
 * identity is bound to one person at a time and keeps who and where it is; a
 * delivery is handled once; a channel automation answers to its own command.
 */

const app = new pg.Pool({ connectionString: APP_URL, max: 3 });
const platform = new pg.Pool({ connectionString: PLATFORM_URL, max: 3 });
const suffix = Date.now().toString(36);

interface Person {
  organizationId: string;
  memberId: string;
}

let ada: Person;
let grace: Person;

async function person(name: string): Promise<Person> {
  const { rows: user } = await platform.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`, [
    `${name}-${suffix}@channels.test`,
    name,
  ]);
  const { rows: org } = await platform.query<{ id: string }>(`INSERT INTO organizations (name, kind, owner_user_id) VALUES ($1, 'shared', $2) RETURNING id`, [
    name,
    user[0]!.id,
  ]);
  const { rows } = await platform.query<{ id: string }>(`INSERT INTO members (organization_id, user_id) VALUES ($1, $2) RETURNING id`, [org[0]!.id, user[0]!.id]);
  return { organizationId: org[0]!.id, memberId: rows[0]!.id };
}

const digest = (code: string) => createHash('sha256').update(code).digest('hex');
const attempt = (p: Person, sql: string, params: unknown[]) => asTenant(app, p, (c) => c.query(sql, params)).catch((e: unknown) => e);

async function code(p: Person, provider = 'telegram', value = `C${Math.random()}`): Promise<string> {
  return asTenant(app, p, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO channel_pairings (organization_id, member_id, provider, code_digest) VALUES ($1, $2, $3, $4) RETURNING id`,
      [p.organizationId, p.memberId, provider, digest(value)],
    );
    return rows[0]!.id;
  });
}

async function identity(p: Person, externalId: string, provider = 'telegram'): Promise<string> {
  return asTenant(app, p, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO channel_identities (organization_id, member_id, provider, external_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [p.organizationId, p.memberId, provider, externalId],
    );
    return rows[0]!.id;
  });
}

beforeAll(async () => {
  ada = await person('Ada');
  grace = await person('Grace');
});

afterAll(async () => {
  await Promise.all([app.end(), platform.end()]);
});

describe('pairing codes', () => {
  it('live an hour at most, whatever the caller asks', async () => {
    const id = await asTenant(app, ada, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO channel_pairings (organization_id, member_id, provider, code_digest, expires_at) VALUES ($1, $2, 'slack', $3, now() + interval '1 day') RETURNING id`,
        [ada.organizationId, ada.memberId, digest(`long-${suffix}`)],
      );
      return rows[0]!.id;
    });
    const { rows } = await platform.query<{ minutes: number }>(`SELECT extract(epoch FROM expires_at - created_at) / 60 AS minutes FROM channel_pairings WHERE id = $1`, [id]);
    expect(Number(rows[0]!.minutes)).toBe(60);
  });

  it('are replaced by a newer code for the same channel', async () => {
    const first = await code(ada, 'whatsapp');
    const second = await code(ada, 'whatsapp');
    const { rows } = await platform.query<{ id: string; live: boolean }>(`SELECT id, expires_at > now() AS live FROM channel_pairings WHERE id = ANY ($1::text[]::ulid[])`, [[first, second]]);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.live]))).toEqual({ [first]: false, [second]: true });
  });

  it('are used once', async () => {
    const id = await code(ada);
    const who = await identity(ada, `tg-once-${suffix}`);
    await asTenant(app, ada, (c) => c.query(`UPDATE channel_pairings SET used_at = now(), identity_id = $2 WHERE id = $1`, [id, who]));
    const again = await attempt(ada, `UPDATE channel_pairings SET used_at = now() + interval '1 second' WHERE id = $1`, [id]);
    expect(hintOf(again)).toBe('channel_pairing_used');
  });

  it('cannot be used once expired, nor have their life extended', async () => {
    const id = await code(ada, 'discord');
    await code(ada, 'discord'); // expires the first
    const late = await attempt(ada, `UPDATE channel_pairings SET used_at = now() WHERE id = $1`, [id]);
    expect(hintOf(late)).toBe('channel_pairing_expired');
    const longer = await attempt(ada, `UPDATE channel_pairings SET expires_at = now() + interval '2 hours' WHERE id = $1`, [id]);
    expect(hintOf(longer)).toBe('channel_pairing_used');
  });

  it('are found by their digest before a tenant is known, and are not readable by another person', async () => {
    const value = `FIND-${suffix}`;
    await code(grace, 'telegram', value);
    const { rows } = await platform.query<{ member_id: string }>(`SELECT member_id FROM channel_pairings WHERE code_digest = $1`, [digest(value)]);
    expect(rows[0]!.member_id).toBe(grace.memberId);
    const seen = await asTenant(app, ada, (c) => c.query(`SELECT 1 FROM channel_pairings WHERE code_digest = $1`, [digest(value)]));
    expect(seen.rows).toHaveLength(0);
  });
});

describe('wrong codes', () => {
  it('lock an identity for an hour at the fifth, and start the count again', async () => {
    const who = `tg-guess-${suffix}`;
    const results: (Date | null)[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { rows } = await platform.query<{ locked: Date | null }>(`SELECT app.channel_pairing_failed('telegram', $1) AS locked`, [who]);
      results.push(rows[0]!.locked);
    }
    expect(results.slice(0, 4).every((r) => r === null)).toBe(true);
    expect(results[4]!.getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);
    const { rows } = await platform.query<{ failures: number }>(`SELECT failures FROM channel_pairing_locks WHERE provider = 'telegram' AND external_id = $1`, [who]);
    expect(rows[0]!.failures).toBe(0);
  });

  it('are the platform’s to count, not a tenant’s', async () => {
    const denied = await attempt(ada, `SELECT * FROM channel_pairing_locks`, []);
    expect(String(denied)).toMatch(/permission denied/);
  });
});

describe('identities', () => {
  it('are bound to one person at a time', async () => {
    const external = `tg-shared-${suffix}`;
    await identity(ada, external);
    const taken = await asTenant(app, grace, (c) =>
      c.query(`INSERT INTO channel_identities (organization_id, member_id, provider, external_id) VALUES ($1, $2, 'telegram', $3)`, [
        grace.organizationId,
        grace.memberId,
        external,
      ]),
    ).catch((e: unknown) => e);
    expect((taken as { code?: string }).code).toBe('23505');
  });

  it('can be claimed again once revoked, and stay revoked', async () => {
    const external = `tg-free-${suffix}`;
    const first = await identity(ada, external);
    await asTenant(app, ada, (c) => c.query(`UPDATE channel_identities SET revoked_at = now() WHERE id = $1`, [first]));
    await expect(identity(grace, external)).resolves.toBeTruthy();
    const back = await attempt(ada, `UPDATE channel_identities SET revoked_at = NULL WHERE id = $1`, [first]);
    expect(hintOf(back)).toBe('channel_identity_fixed');
  });

  it('keep who and where they are', async () => {
    const id = await identity(ada, `tg-fixed-${suffix}`);
    const moved = await attempt(ada, `UPDATE channel_identities SET external_id = 'someone-else' WHERE id = $1`, [id]);
    expect(String(moved)).toMatch(/permission denied/);
  });

  it('refuse a time zone that is not one', async () => {
    const zone = await attempt(ada, `INSERT INTO channel_identities (organization_id, member_id, provider, external_id, time_zone) VALUES ($1, $2, 'slack', 'T:U1', 'Mars/Olympus')`, [
      ada.organizationId,
      ada.memberId,
    ]);
    expect(String(zone)).toMatch(/time zone/);
  });

  it('are the person’s own', async () => {
    const id = await identity(grace, `tg-private-${suffix}`);
    const { rows } = await asTenant(app, ada, (c) => c.query(`SELECT 1 FROM channel_identities WHERE id = $1`, [id]));
    expect(rows).toHaveLength(0);
  });
});

describe('deliveries and threads', () => {
  it('handle a delivery once', async () => {
    const id = `upd-${suffix}`;
    const first = await platform.query(`INSERT INTO channel_events (provider, event_id) VALUES ('telegram', $1) ON CONFLICT DO NOTHING`, [id]);
    const second = await platform.query(`INSERT INTO channel_events (provider, event_id) VALUES ('telegram', $1) ON CONFLICT DO NOTHING`, [id]);
    expect([first.rowCount, second.rowCount]).toEqual([1, 0]);
  });

  it('keep one thread per chat, pointing at the person’s own conversation', async () => {
    const who = await identity(ada, `tg-thread-${suffix}`);
    await asTenant(app, ada, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO agent_conversations (organization_id, member_id, model) VALUES ($1, $2, 'anthropic/claude-sonnet-5-5') RETURNING id`,
        [ada.organizationId, ada.memberId],
      );
      await c.query(`INSERT INTO channel_threads (organization_id, member_id, identity_id, chat_id, conversation_id) VALUES ($1, $2, $3, 'chat-1', $4)`, [
        ada.organizationId,
        ada.memberId,
        who,
        rows[0]!.id,
      ]);
    });
    const twice = await attempt(ada, `INSERT INTO channel_threads (organization_id, member_id, identity_id, chat_id, conversation_id) SELECT organization_id, member_id, identity_id, chat_id, conversation_id FROM channel_threads WHERE identity_id = $1`, [who]);
    expect((twice as { code?: string }).code).toBe('23505');
  });
});

describe('channel automations', () => {
  it('need their command, and only they have one', async () => {
    const agentId = await asTenant(app, ada, async (c) => {
      const { rows } = await c.query<{ id: string }>(`INSERT INTO agents (organization_id, member_id, name) VALUES ($1, $2, 'Bot') RETURNING id`, [ada.organizationId, ada.memberId]);
      return rows[0]!.id;
    });
    const insert = (kind: string, command: string | null) =>
      attempt(ada, `INSERT INTO automations (organization_id, member_id, name, kind, target_agent_id, prompt, channel_command) VALUES ($1, $2, 'X', $3, $4, 'Go', $5)`, [
        ada.organizationId,
        ada.memberId,
        kind,
        agentId,
        command,
      ]);
    expect(hintOf(await insert('channel', null))).toBe('automation_invalid');
    expect(hintOf(await insert('manual', 'report'))).toBe('automation_invalid');
    expect(await insert('channel', 'report')).toMatchObject({ rowCount: 1 });
    expect((await insert('channel', 'report')) as { code?: string }).toMatchObject({ code: '23505' });
  });
});
