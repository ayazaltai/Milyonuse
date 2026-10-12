import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../common/app-error.js';
import { loadEnv } from '../../config/env.js';
import { hintOf } from '../tenancy/database-error.js';
import type { AutomationsStore } from './automations.store.js';
import { hookSecret } from './automations.service.js';
import { HOOK_MAX_BYTES, HookIntake, signHook } from './hook-intake.js';
import type { AutomationLauncher } from './launcher.js';

const TOKEN = 'a1'.repeat(24);
const env = loadEnv({ DATABASE_URL: 'postgres://x@localhost/x', INBOUND_MAIL_SECRET: 'i'.repeat(40) } as NodeJS.ProcessEnv);

/** An intake whose database knows one automation and records what it is given. */
function intake(options: { kind?: string; seen?: Set<string> } = {}) {
  const accepted: { source: string; dedupeKey: string; payload: Record<string, unknown> }[] = [];
  const seen = options.seen ?? new Set<string>();
  const platform = {
    query: async (_sql: string, params: unknown[]) => ({
      rows: params[0] === TOKEN && params[1] === (options.kind ?? params[1]) ? [{ id: 'auto1', organization_id: 'org1', member_id: 'mem1' }] : [],
    }),
  } as unknown as pg.Pool;
  const store = { run: (_o: unknown, fn: (c: unknown) => unknown) => fn({}), get: async () => ({ id: 'auto1' }) } as unknown as AutomationsStore;
  const launcher = {
    principalOf: async () => ({ organizationId: 'org1', memberId: 'mem1' }),
    accept: async (_c: unknown, _o: unknown, _a: unknown, event: { source: string; dedupeKey: string; payload: Record<string, unknown> }) => {
      if (seen.has(event.dedupeKey)) return null;
      seen.add(event.dedupeKey);
      accepted.push(event);
      return { id: `trig${accepted.length}` };
    },
    kick: () => undefined,
  } as unknown as AutomationLauncher;
  return { hooks: new HookIntake(store, launcher, platform, env), accepted };
}

const secret = hookSecret(env, TOKEN);
const now = 1_800_000_000_000;
const ts = now / 1000;
const headers = (body: string, at = ts, extra: Record<string, string> = {}) => ({ timestamp: String(at), signature: `sha256=${signHook(secret, at, body)}`, ...extra });

describe('HookIntake — webhooks', () => {
  it('derives the same secret for the same address, and a different one for another', () => {
    expect(hookSecret(env, TOKEN)).toBe(secret);
    expect(hookSecret(env, 'b2'.repeat(24))).not.toBe(secret);
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
  });

  it('accepts a body signed with the address’s secret, keyed by its delivery id', async () => {
    const { hooks, accepted } = intake({ kind: 'webhook' });
    const body = '{"lead":"Linus"}';
    const answer = await hooks.webhook(TOKEN, body, headers(body, ts, { delivery: 'evt_9' }), now);
    expect(answer).toEqual({ accepted: true, duplicate: false, triggerId: 'trig1' });
    expect(accepted[0]).toMatchObject({ source: 'webhook', dedupeKey: 'delivery:evt_9', payload: { lead: 'Linus' } });
  });

  it('keys a delivery without an id by its body, so a resend is a duplicate', async () => {
    const { hooks } = intake({ kind: 'webhook' });
    const body = '{"a":1}';
    await hooks.webhook(TOKEN, body, headers(body), now);
    expect(await hooks.webhook(TOKEN, body, headers(body), now)).toEqual({ accepted: false, duplicate: true, triggerId: null });
  });

  it('keeps a body that is not an object as data under `body`', async () => {
    const { hooks, accepted } = intake({ kind: 'webhook' });
    await hooks.webhook(TOKEN, '[1,2]', headers('[1,2]'), now);
    await hooks.webhook(TOKEN, 'plain text', headers('plain text'), now);
    expect(accepted.map((a) => a.payload)).toEqual([{ body: [1, 2] }, { body: 'plain text' }]);
  });

  it('refuses a timestamp more than five minutes away, either way', async () => {
    const { hooks } = intake({ kind: 'webhook' });
    for (const at of [ts - 301, ts + 301]) {
      await expect(hooks.webhook(TOKEN, '{}', headers('{}', at), now)).rejects.toMatchObject({ code: 'unauthenticated' });
    }
    await expect(hooks.webhook(TOKEN, '{}', headers('{}', ts - 299), now)).resolves.toMatchObject({ accepted: true });
  });

  it('refuses a missing or wrong signature', async () => {
    const { hooks } = intake({ kind: 'webhook' });
    await expect(hooks.webhook(TOKEN, '{}', { timestamp: String(ts) }, now)).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(hooks.webhook(TOKEN, '{}', { timestamp: String(ts), signature: `sha256=${signHook('whsec_x', ts, '{}')}` }, now)).rejects.toBeInstanceOf(AppError);
  });

  it('refuses a body over the limit before reading anything', async () => {
    const { hooks } = intake({ kind: 'webhook' });
    const big = 'x'.repeat(HOOK_MAX_BYTES + 1);
    await expect(hooks.webhook(TOKEN, big, headers(big), now)).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('answers an unknown address as not found', async () => {
    const { hooks } = intake({ kind: 'webhook' });
    await expect(hooks.webhook('c3'.repeat(24), '{}', headers('{}'), now)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('HookIntake — mail', () => {
  const bearer = `Bearer ${'i'.repeat(40)}`;

  it('finds the automation by the address, with a display name and a +tag', async () => {
    const { hooks, accepted } = intake({ kind: 'email' });
    const answer = await hooks.mail(bearer, { to: `Invoices <${TOKEN}+march@in.milyonuse.com>`, from: 'a@b.c', subject: 'Invoice', text: 'Total', messageId: '<1@b.c>' });
    expect(answer.accepted).toBe(true);
    expect(accepted[0]).toMatchObject({ source: 'email', dedupeKey: 'mail:<1@b.c>', payload: { from: 'a@b.c', subject: 'Invoice', text: 'Total' } });
  });

  it('is not there without the provider’s secret, and refuses a wrong bearer', async () => {
    const quiet = new HookIntake({} as AutomationsStore, {} as AutomationLauncher, {} as pg.Pool, loadEnv({ DATABASE_URL: 'postgres://x@localhost/x' } as NodeJS.ProcessEnv));
    await expect(quiet.mail(bearer, {})).rejects.toMatchObject({ code: 'not_found' });
    await expect(intake().hooks.mail('Bearer nope', { to: `${TOKEN}@in.milyonuse.com` })).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('answers an address that names no automation as not found', async () => {
    await expect(intake().hooks.mail(bearer, { to: 'someone@in.milyonuse.com' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('hintOf', () => {
  it('reads a refusal’s hint on the error, or on the one an AppError wraps', () => {
    const pgError = Object.assign(new Error('refused'), { hint: 'automation_chain_loop' });
    expect(hintOf(pgError)).toBe('automation_chain_loop');
    expect(hintOf(new AppError('conflict', 'x', { cause: pgError }))).toBe('automation_chain_loop');
    expect(hintOf(new Error('plain'))).toBeNull();
    expect(hintOf(null)).toBeNull();
  });
});
