import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PLATFORM_URL } from './database/database.testing.js';
import { type TestApp, createTestApp, lastMail, sessionOf, tokenIn } from './testing/test-app.js';

/**
 * Accounts over HTTP: registering, confirming the address, the personal
 * workspace that opens with it, signing in, the person's own profile and
 * sessions, and setting a new password.
 *
 * The mail is read the way the recipient would read it: a link's token exists
 * there and nowhere else — the database holds its digest.
 */

const suffix = Date.now().toString(36);
const platform = new pg.Pool({ connectionString: PLATFORM_URL, max: 3 });
const PASSWORD = 'violet-harbour-lantern';
const email = (name: string): string => `${name}-${suffix}@auth.e2e.test`;
let api: TestApp;

function registration(address: string, overrides: Record<string, unknown> = {}) {
  return { name: 'Ada Lovelace', email: address, password: PASSWORD, acceptTerms: true, ...overrides };
}

/** Registers, follows the link, and returns the session cookie it sets. */
async function registerAndVerify(address: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const registered = await api.request('POST', '/auth/register', { payload: registration(address, overrides) });
  expect(registered.statusCode).toBe(202);
  const verified = await api.request('POST', '/auth/verify', {
    payload: { token: tokenIn(lastMail(api.outbox, address), 'verify') },
  });
  expect(verified.statusCode).toBe(201);
  const cookie = sessionOf(verified);
  if (!cookie) throw new Error(`no session for ${address}: ${verified.body}`);
  return cookie;
}

beforeAll(async () => {
  api = await createTestApp();
}, 90_000);

afterAll(async () => {
  await api?.close();
  await platform.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${suffix}@auth.e2e.test`]);
  await platform.query(`DELETE FROM account_tokens WHERE email LIKE $1`, [`%-${suffix}@auth.e2e.test`]);
  await platform.end();
});

describe('registering', () => {
  const address = email('founder');
  let cookie: string;

  it('answers "check your inbox" and creates nothing until the address is confirmed', async () => {
    const response = await api.request('POST', '/auth/register', {
      payload: registration(address, { locale: 'tr', timeZone: 'Europe/Istanbul' }),
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'verification_sent' });

    const mail = lastMail(api.outbox, address);
    // Written in the language the person chose.
    expect(mail.subject).toBe('Milyonuse e-posta adresini doğrula');
    expect(mail.text).toContain('http://127.0.0.1:3000/verify?token=');

    const users = await platform.query(`SELECT 1 FROM users WHERE email = $1`, [address]);
    expect(users.rows).toHaveLength(0);
    // What waits is a digest of the password, never the password.
    const { rows } = await platform.query<{ payload: Record<string, string> }>(
      `SELECT payload FROM account_tokens WHERE purpose = 'verify_email' AND email = $1`,
      [address],
    );
    expect(rows[0]!.payload['passwordHash']).toMatch(/^scrypt\$/);
    expect(JSON.stringify(rows[0]!.payload)).not.toContain(PASSWORD);
  });

  it('opens the person, their personal workspace, its owner and a session when the link is followed', async () => {
    const verified = await api.request('POST', '/auth/verify', {
      payload: { token: tokenIn(lastMail(api.outbox, address), 'verify') },
    });
    expect(verified.statusCode).toBe(201);
    cookie = sessionOf(verified)!;
    expect(cookie).toBeTruthy();

    const { rows } = await platform.query<{ kind: string; role: string; locale: string; time_zone: string }>(
      `SELECT o.kind, m.role, u.locale, u.time_zone
         FROM users u
         JOIN organizations o ON o.owner_user_id = u.id
         JOIN members m ON m.organization_id = o.id AND m.user_id = u.id
        WHERE u.email = $1`,
      [address],
    );
    expect(rows).toEqual([{ kind: 'personal', role: 'owner', locale: 'tr', time_zone: 'Europe/Istanbul' }]);

    // The session holds only the token's digest.
    const sessions = await platform.query<{ token_hash: string }>(
      `SELECT s.token_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1`,
      [address],
    );
    expect(sessions.rows).toHaveLength(1);
    expect(sessions.rows[0]!.token_hash).not.toContain(cookie);
  });

  it('spends the link: a second click opens nothing', async () => {
    const again = await api.request('POST', '/auth/verify', {
      payload: { token: tokenIn(lastMail(api.outbox, address), 'verify') },
    });
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe('not_found');
  });

  it('says who is signed in, and where', async () => {
    const session = await api.request('GET', '/auth/session', { cookie });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      user: { email: address, name: 'Ada Lovelace', locale: 'tr', timeZone: 'Europe/Istanbul' },
      organization: { kind: 'personal' },
      member: { role: 'owner' },
    });
  });

  it('answers the same for an address that already has an account, and tells its owner by mail', async () => {
    const response = await api.request('POST', '/auth/register', { payload: registration(address) });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'verification_sent' });
    expect(lastMail(api.outbox, address).subject).toBe('Zaten bir Milyonuse hesabın var');
  });

  it('refuses a weak password, and terms not accepted', async () => {
    const weak = await api.request('POST', '/auth/register', {
      payload: registration(email('weak'), { password: 'password123' }),
    });
    expect(weak.statusCode).toBe(422);
    const terms = await api.request('POST', '/auth/register', {
      payload: registration(email('terms'), { acceptTerms: false }),
    });
    expect(terms.statusCode).toBe(422);
  });

  it('refuses a time zone the database does not know, and creates nothing', async () => {
    const unknown = email('nowhere');
    await api.request('POST', '/auth/register', {
      payload: registration(unknown, { timeZone: 'Mars/Olympus_Mons' }),
    });
    const verified = await api.request('POST', '/auth/verify', {
      payload: { token: tokenIn(lastMail(api.outbox, unknown), 'verify') },
    });
    expect(verified.statusCode).toBe(422);
    expect(verified.json().error.code).toBe('validation_failed');
    const users = await platform.query(`SELECT 1 FROM users WHERE email = $1`, [unknown]);
    expect(users.rows).toHaveLength(0);
  });
});

describe('signing in', () => {
  const address = email('returning');

  beforeAll(async () => {
    await registerAndVerify(address);
  });

  it('signs in with the right password', async () => {
    const response = await api.request('POST', '/auth/login', { payload: { email: address, password: PASSWORD } });
    expect(response.statusCode).toBe(200);
    expect(sessionOf(response)).toBeTruthy();
  });

  it('gives one answer for a wrong password and an unknown address', async () => {
    const wrong = await api.request('POST', '/auth/login', { payload: { email: address, password: 'not-it-at-all' } });
    const unknown = await api.request('POST', '/auth/login', {
      payload: { email: email('nobody'), password: PASSWORD },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error).toMatchObject({ code: 'invalid_credentials' });
    expect(unknown.json().error.message).toBe(wrong.json().error.message);
  });

  it('holds back a guesser after five tries at one address', async () => {
    const target = email('guessed');
    const codes: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const response = await api.request('POST', '/auth/login', { payload: { email: target, password: `guess-${i}` } });
      codes.push(response.statusCode);
    }
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes[5]).toBe(429);
  });

  it('signs out, and the cookie opens nothing afterwards', async () => {
    const signedIn = await api.request('POST', '/auth/login', { payload: { email: address, password: PASSWORD } });
    const cookie = sessionOf(signedIn)!;
    const out = await api.request('POST', '/auth/logout', { cookie });
    expect(out.statusCode).toBe(200);
    const after = await api.request('GET', '/auth/session', { cookie });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('session_expired');
  });

  it('answers 401 to nobody', async () => {
    const response = await api.request('GET', '/auth/session');
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('unauthenticated');
  });
});

describe('the person’s own account', () => {
  const address = email('profile');
  let cookie: string;

  beforeAll(async () => {
    cookie = await registerAndVerify(address);
  });

  it('changes name, language and time zone, and keeps a record of it', async () => {
    const response = await api.request('PATCH', '/me', {
      cookie,
      payload: { name: 'Ada King', locale: 'tr', timeZone: 'America/New_York' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ name: 'Ada King', locale: 'tr', timeZone: 'America/New_York' });

    const { rows } = await platform.query<{ action: string; before: { name: string } }>(
      `SELECT a.action, a.before FROM audit_log a
         JOIN members m ON m.id = a.actor_member_id
         JOIN users u ON u.id = m.user_id
        WHERE u.email = $1 AND a.action = 'user.profile_changed'`,
      [address],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before.name).toBe('Ada Lovelace');
  });

  it('refuses an unknown time zone with a field-level answer', async () => {
    const response = await api.request('PATCH', '/me', { cookie, payload: { timeZone: 'Atlantis/Lost_City' } });
    expect(response.statusCode).toBe(422);
  });

  it('lists the person’s sessions, marks this one, and ends another', async () => {
    const other = sessionOf(
      await api.request('POST', '/auth/login', { payload: { email: address, password: PASSWORD } }),
    )!;
    const listed = await api.request('GET', '/me/sessions', { cookie });
    const items = listed.json().items as { id: string; current: boolean }[];
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.filter((s) => s.current)).toHaveLength(1);

    const target = items.find((s) => !s.current)!;
    const ended = await api.request('DELETE', `/me/sessions/${target.id}`, { cookie });
    expect(ended.statusCode).toBe(200);
    expect((await api.request('GET', '/auth/session', { cookie: other })).statusCode).toBe(401);
  });

  it('cannot end a session that belongs to someone else', async () => {
    const strangerCookie = await registerAndVerify(email('stranger'));
    const theirs = (await api.request('GET', '/me/sessions', { cookie: strangerCookie })).json().items[0].id;
    const attempt = await api.request('DELETE', `/me/sessions/${theirs}`, { cookie });
    expect(attempt.statusCode).toBe(404);
    expect((await api.request('GET', '/auth/session', { cookie: strangerCookie })).statusCode).toBe(200);
  });

  it('changes the password only with the current one, and ends every other session', async () => {
    const other = sessionOf(
      await api.request('POST', '/auth/login', { payload: { email: address, password: PASSWORD } }),
    )!;
    const refused = await api.request('POST', '/me/password', {
      cookie,
      payload: { currentPassword: 'not-the-password', newPassword: 'ember-canyon-ribbon' },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('reauthentication_failed');

    const changed = await api.request('POST', '/me/password', {
      cookie,
      payload: { currentPassword: PASSWORD, newPassword: 'ember-canyon-ribbon' },
    });
    expect(changed.statusCode).toBe(200);
    expect((await api.request('GET', '/auth/session', { cookie })).statusCode).toBe(200);
    expect((await api.request('GET', '/auth/session', { cookie: other })).statusCode).toBe(401);
    expect(lastMail(api.outbox, address).subject).toBe('Milyonuse şifren değişti');
  });
});

describe('a forgotten password', () => {
  const address = email('forgetful');
  let cookie: string;

  beforeAll(async () => {
    cookie = await registerAndVerify(address);
  });

  it('answers the same for every address, and mails the one with an account a link', async () => {
    const known = await api.request('POST', '/auth/password/forgot', { payload: { email: address } });
    const unknown = await api.request('POST', '/auth/password/forgot', {
      payload: { email: email('ghost') },
      headers: { 'accept-language': 'tr-TR,tr;q=0.9' },
    });
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.json()).toEqual(unknown.json());
    expect(lastMail(api.outbox, address).text).toContain('/reset?token=');
    // Someone the product does not know is written to in their browser's language.
    expect(lastMail(api.outbox, email('ghost')).subject).toBe('Bu adres için Milyonuse hesabı yok');
  });

  it('sets the new password, signs the person out everywhere, and spends the link', async () => {
    const token = tokenIn(lastMail(api.outbox, address), 'reset');
    const weak = await api.request('POST', '/auth/password/reset', { payload: { token, password: 'aaaaaaaaaaaa' } });
    expect(weak.statusCode).toBe(422);

    // A refused password leaves the link usable for a better one.
    const reset = await api.request('POST', '/auth/password/reset', {
      payload: { token, password: 'quartz-meadow-signal' },
    });
    expect(reset.statusCode).toBe(200);
    expect((await api.request('GET', '/auth/session', { cookie })).statusCode).toBe(401);

    const again = await api.request('POST', '/auth/password/reset', {
      payload: { token, password: 'another-good-password' },
    });
    expect(again.statusCode).toBe(404);

    const signedIn = await api.request('POST', '/auth/login', {
      payload: { email: address, password: 'quartz-meadow-signal' },
    });
    expect(signedIn.statusCode).toBe(200);
  });
});

describe('a closed registration', () => {
  it('refuses to register and to open an account from a link', async () => {
    const closed = await createTestApp({ SIGNUP_ENABLED: 'false' });
    try {
      const response = await closed.request('POST', '/auth/register', { payload: registration(email('late')) });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('signup_closed');
    } finally {
      await closed.close();
      process.env['SIGNUP_ENABLED'] = 'true';
    }
  });
});
