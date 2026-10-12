import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { APP_URL, OWNER_URL, PLATFORM_URL, asTenant, hintOf } from './testing.js';

/**
 * The rules 0013_automations enforces: when a schedule next runs, in its own
 * time zone across daylight-saving changes; what each kind needs; trusted only
 * when confirmed; a pause after three failures; one run per event; chains at
 * most three deep and never looping; all of it one person's.
 */

const app = new pg.Pool({ connectionString: APP_URL, max: 3 });
const platform = new pg.Pool({ connectionString: PLATFORM_URL, max: 3 });
const owner = new pg.Pool({ connectionString: OWNER_URL, max: 2 });
const suffix = Date.now().toString(36);

interface Person {
  organizationId: string;
  memberId: string;
}

let ada: Person;
let grace: Person;
let adaAgent: string;

async function person(name: string, organizationId?: string): Promise<Person> {
  const { rows: user } = await platform.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`, [
    `${name}-${suffix}@automations.test`,
    name,
  ]);
  let org = organizationId;
  if (!org) {
    const { rows } = await platform.query<{ id: string }>(`INSERT INTO organizations (name, kind, owner_user_id) VALUES ($1, 'shared', $2) RETURNING id`, [
      name,
      user[0]!.id,
    ]);
    org = rows[0]!.id;
  }
  const { rows } = await platform.query<{ id: string }>(`INSERT INTO members (organization_id, user_id) VALUES ($1, $2) RETURNING id`, [org, user[0]!.id]);
  return { organizationId: org, memberId: rows[0]!.id };
}

const attempt = (p: Person, sql: string, params: unknown[]) => asTenant(app, p, (c) => c.query(sql, params)).catch((e: unknown) => e);

async function agent(p: Person): Promise<string> {
  return asTenant(app, p, async (c) => {
    const { rows } = await c.query<{ id: string }>(`INSERT INTO agents (organization_id, member_id, name) VALUES ($1, $2, 'Watcher') RETURNING id`, [
      p.organizationId,
      p.memberId,
    ]);
    const v = await c.query<{ id: string }>(`INSERT INTO agent_versions (organization_id, member_id, agent_id) VALUES ($1, $2, $3) RETURNING id`, [
      p.organizationId,
      p.memberId,
      rows[0]!.id,
    ]);
    await c.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [rows[0]!.id, v.rows[0]!.id]);
    return rows[0]!.id;
  });
}

/** An automation; `fields` are columns and their values. */
async function automation(p: Person, agentId: string, fields: Record<string, unknown>): Promise<string | unknown> {
  const columns = ['organization_id', 'member_id', 'name', 'target_agent_id', 'prompt', ...Object.keys(fields)];
  const values = [p.organizationId, p.memberId, 'Weekly report', agentId, 'Write the weekly report', ...Object.values(fields)];
  const result = await attempt(
    p,
    `INSERT INTO automations (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    values,
  );
  return (result as pg.QueryResult<{ id: string }>).rows?.[0]?.id ?? result;
}

const next = async (cadence: string, opts: { weekdays?: number[]; monthDay?: number; time: string; every?: number; zone: string; after: string }) => {
  const { rows } = await owner.query<{ at: string }>(
    `SELECT to_char(app.automation_next($1, $2::smallint[], $3::smallint, $4::time, $5::smallint, $6, $7::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS at`,
    [cadence, opts.weekdays ?? [], opts.monthDay ?? null, opts.time, opts.every ?? null, opts.zone, opts.after],
  );
  return rows[0]!.at;
};

beforeAll(async () => {
  ada = await person('ada');
  grace = await person('grace', ada.organizationId);
  adaAgent = await agent(ada);
});

afterAll(async () => {
  await platform.query(`DELETE FROM organizations WHERE id = $1`, [ada.organizationId]);
  await platform.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${suffix}@automations.test`]);
  await Promise.all([app.end(), platform.end(), owner.end()]);
});

describe('when a schedule next runs', () => {
  it('keeps 09:00 in Istanbul (UTC+3 all year) — 06:00 UTC on either side of Europe’s clock change (acceptance 1)', async () => {
    expect(await next('daily', { time: '09:00', zone: 'Europe/Istanbul', after: '2026-03-28T12:00Z' })).toBe('2026-03-29 06:00');
    expect(await next('daily', { time: '09:00', zone: 'Europe/Istanbul', after: '2026-10-24T12:00Z' })).toBe('2026-10-25 06:00');
  });

  it('keeps the local hour across daylight saving where the clock does change', async () => {
    // Berlin springs forward on 29 March 2026: 09:00 is 08:00 UTC before, 07:00 UTC after.
    expect(await next('daily', { time: '09:00', zone: 'Europe/Berlin', after: '2026-03-27T12:00Z' })).toBe('2026-03-28 08:00');
    expect(await next('daily', { time: '09:00', zone: 'Europe/Berlin', after: '2026-03-28T12:00Z' })).toBe('2026-03-29 07:00');
    // New York falls back on 1 November 2026: 09:00 is 13:00 UTC before, 14:00 UTC after.
    expect(await next('daily', { time: '09:00', zone: 'America/New_York', after: '2026-10-31T15:00Z' })).toBe('2026-11-01 14:00');
  });

  it('honours weekdays, weekly days, the last day of a short month, and every few hours', async () => {
    // Saturday 10 October 2026 → the next weekday is Monday the 12th.
    expect(await next('weekdays', { time: '08:30', zone: 'UTC', after: '2026-10-10T09:00Z' })).toBe('2026-10-12 08:30');
    expect(await next('weekly', { weekdays: [3, 5], time: '10:00', zone: 'UTC', after: '2026-10-12T00:00Z' })).toBe('2026-10-14 10:00');
    expect(await next('monthly', { monthDay: 31, time: '08:00', zone: 'UTC', after: '2026-02-01T00:00Z' })).toBe('2026-02-28 08:00');
    expect(await next('hourly', { every: 3, time: '00:15', zone: 'Europe/Istanbul', after: '2026-10-12T07:00Z' })).toBe('2026-10-12 09:15');
  });

  it('is set by the database when an automation is made, changed or turned back on', async () => {
    const id = (await automation(ada, adaAgent, { kind: 'schedule', cadence: 'daily', local_time: '09:00', time_zone: 'Europe/Istanbul' })) as string;
    const read = async () =>
      (await asTenant(app, ada, (c) => c.query<{ next_run_at: Date | null }>(`SELECT next_run_at FROM automations WHERE id = $1`, [id]))).rows[0]!.next_run_at;
    const first = await read();
    expect(first).toBeInstanceOf(Date);
    expect(first!.getUTCHours()).toBe(6);
    await attempt(ada, `UPDATE automations SET local_time = '18:30' WHERE id = $1`, [id]);
    expect((await read())!.getUTCHours()).toBe(15);
    expect(hintOf(await attempt(ada, `UPDATE automations SET time_zone = 'Mars/Olympus' WHERE id = $1`, [id]))).toBeUndefined();
  });
});

describe('an automation', () => {
  it('needs what its kind needs', async () => {
    expect(hintOf(await automation(ada, adaAgent, { kind: 'schedule' }))).toBe('automation_invalid');
    expect(hintOf(await automation(ada, adaAgent, { kind: 'schedule', cadence: 'weekly', local_time: '09:00' }))).toBe('automation_invalid');
    expect(hintOf(await automation(ada, adaAgent, { kind: 'monitor', cadence: 'hourly', every_hours: 1, local_time: '00:00' }))).toBe('automation_invalid');
    expect(hintOf(await automation(ada, adaAgent, { kind: 'webhook' }))).toBe('automation_invalid');
    expect(hintOf(await automation(ada, adaAgent, { kind: 'agent_event' }))).toBe('automation_invalid');
    expect(typeof (await automation(ada, adaAgent, { kind: 'manual' }))).toBe('string');
  });

  it('is trusted only once the person confirmed it', async () => {
    expect((await automation(ada, adaAgent, { kind: 'manual', policy: 'trusted' })) as { code?: string }).toMatchObject({ code: '23514' });
    expect(typeof (await automation(ada, adaAgent, { kind: 'manual', policy: 'trusted', trusted_confirmed_at: new Date() }))).toBe('string');
  });

  it('pauses itself after three failures in a row, and counts afresh when turned back on', async () => {
    const id = (await automation(ada, adaAgent, { kind: 'manual' })) as string;
    await attempt(ada, `UPDATE automations SET consecutive_failures = 3 WHERE id = $1`, [id]);
    const row = async () =>
      (await asTenant(app, ada, (c) => c.query<{ enabled: boolean; paused_reason: string | null; consecutive_failures: number }>(`SELECT enabled, paused_reason, consecutive_failures FROM automations WHERE id = $1`, [id]))).rows[0]!;
    expect(await row()).toMatchObject({ enabled: false, paused_reason: 'Paused after three failures in a row.' });
    await attempt(ada, `UPDATE automations SET enabled = true WHERE id = $1`, [id]);
    expect(await row()).toMatchObject({ enabled: true, paused_reason: null, consecutive_failures: 0 });
  });

  it('keeps its kind, and never follows itself', async () => {
    const id = (await automation(ada, adaAgent, { kind: 'manual' })) as string;
    expect(String(await attempt(ada, `UPDATE automations SET kind = 'webhook' WHERE id = $1`, [id]))).toMatch(/permission denied/);
    const asOwner = await asTenant(owner, ada, (c) => c.query(`UPDATE automations SET kind = 'webhook', hook_token = 'abcdefghijklmnopqrstuvwxyz12' WHERE id = $1`, [id])).catch((e: unknown) => e);
    expect(hintOf(asOwner)).toBe('automation_invalid');
    const follower = (await automation(ada, adaAgent, { kind: 'agent_event', watch_automation_id: id })) as string;
    expect(hintOf(await attempt(ada, `UPDATE automations SET watch_automation_id = $1 WHERE id = $1`, [follower]))).toBe('automation_chain_loop');
  });

  it('is one person’s, and runs only their own agents', async () => {
    const id = (await automation(ada, adaAgent, { kind: 'manual' })) as string;
    expect((await asTenant(app, grace, (c) => c.query(`SELECT 1 FROM automations WHERE id = $1`, [id]))).rowCount).toBe(0);
    expect(((await automation(grace, adaAgent, { kind: 'manual' })) as { code?: string }).code).toBe('23503');
  });
});

describe('a trigger', () => {
  const trigger = (automationId: string, key: string, chain: string[] = []) =>
    attempt(ada, `INSERT INTO automation_triggers (organization_id, member_id, automation_id, source, dedupe_key, chain) VALUES ($1, $2, $3, 'webhook', $4, $5::text[]) RETURNING id`, [
      ada.organizationId,
      ada.memberId,
      automationId,
      key,
      chain,
    ]);

  it('is accepted once per event: the same delivery twice is refused (acceptance 2)', async () => {
    const id = (await automation(ada, adaAgent, { kind: 'manual' })) as string;
    expect(await trigger(id, 'delivery-1')).toMatchObject({ rowCount: 1 });
    expect((await trigger(id, 'delivery-1')) as { code?: string }).toMatchObject({ code: '23505' });
    expect(await trigger(id, 'delivery-2')).toMatchObject({ rowCount: 1 });
  });

  it('never runs an automation twice in one chain, nor deeper than three (acceptance 5)', async () => {
    const [a, b, c, d] = [
      (await automation(ada, adaAgent, { kind: 'manual' })) as string,
      (await automation(ada, adaAgent, { kind: 'manual' })) as string,
      (await automation(ada, adaAgent, { kind: 'manual' })) as string,
      (await automation(ada, adaAgent, { kind: 'manual' })) as string,
    ];
    expect(hintOf(await trigger(a, 'loop', [a, b]))).toBe('automation_chain_loop');
    expect(hintOf(await trigger(d, 'deep', [a, b, c]))).toBe('automation_chain_too_deep');
    expect(await trigger(c, 'ok', [a, b])).toMatchObject({ rowCount: 1 });
  });

  it('is a record: what arrived never changes, and it is decided once', async () => {
    const id = (await automation(ada, adaAgent, { kind: 'manual' })) as string;
    await trigger(id, 'k1');
    const asOwner = await asTenant(owner, ada, (c) => c.query(`UPDATE automation_triggers SET payload = '{"x":1}' WHERE automation_id = $1`, [id])).catch((e: unknown) => e);
    expect(hintOf(asOwner)).toBe('automation_trigger_immutable');
    await attempt(ada, `UPDATE automation_triggers SET status = 'skipped', reason = 'quiet hours' WHERE automation_id = $1`, [id]);
    expect(hintOf(await attempt(ada, `UPDATE automation_triggers SET status = 'started' WHERE automation_id = $1`, [id]))).toBe('automation_trigger_immutable');
  });
});

describe('the inbox', () => {
  it('holds one of each suggestion, and only the person’s', async () => {
    const add = (p: Person) =>
      attempt(p, `INSERT INTO inbox_items (organization_id, member_id, kind, title, dedupe_key) VALUES ($1, $2, 'suggestion', 'Automate your Friday report?', 'suggest:friday')`, [
        p.organizationId,
        p.memberId,
      ]);
    expect(await add(ada)).toMatchObject({ rowCount: 1 });
    expect((await add(ada)) as { code?: string }).toMatchObject({ code: '23505' });
    expect((await asTenant(app, grace, (c) => c.query(`SELECT 1 FROM inbox_items WHERE dedupe_key = 'suggest:friday' AND member_id = $1`, [ada.memberId]))).rowCount).toBe(0);
  });
});
