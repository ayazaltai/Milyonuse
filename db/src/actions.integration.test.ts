import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { APP_URL, OWNER_URL, PLATFORM_URL, asTenant, hintOf } from './testing.js';

/**
 * The rules 0009_actions enforces: a proposal's content is fixed, it runs at
 * most once and only within its day, an irreversible call never runs without a
 * person, an undo names a completed action of one's own, an item claimed once
 * is never run twice, a revoked connection loses its secrets and stays
 * revoked, an authorization is used once, and all of it is one person's.
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
let linus: Person;
let adaConversation: string;
let graceConversation: string;

async function user(name: string): Promise<string> {
  const { rows } = await platform.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`, [
    `${name}-${suffix}@actions.test`,
    name,
  ]);
  return rows[0]!.id;
}

async function member(organizationId: string, userId: string, role: string): Promise<Person> {
  const { rows } = await platform.query<{ id: string }>(
    `INSERT INTO members (organization_id, user_id, role) VALUES ($1, $2, $3) RETURNING id`,
    [organizationId, userId, role],
  );
  return { organizationId, memberId: rows[0]!.id };
}

async function conversation(person: Person): Promise<string> {
  return asTenant(app, person, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO agent_conversations (organization_id, member_id, model) VALUES ($1, $2, 'anthropic/claude-sonnet-5-5') RETURNING id`,
      [person.organizationId, person.memberId],
    );
    return rows[0]!.id;
  });
}

interface ProposalInput {
  tool?: string;
  risk?: 'safe' | 'caution' | 'danger';
  reversible?: boolean;
  autoConfirmed?: boolean;
  itemCount?: number;
  undoOf?: string | null;
  expiresIn?: string;
}

async function propose(person: Person, conversationId: string, input: ProposalInput = {}): Promise<string> {
  return asTenant(app, person, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO agent_actions (organization_id, member_id, conversation_id, tool, args, preview, risk, reversible, reason,
                                  item_count, auto_confirmed, undo_of, expires_at)
       VALUES ($1, $2, $3, $4, '{"to":"a@example.com"}', '{"title":"Send"}', $5, $6, 'test', $7, $8, $9,
               now() + $10::interval)
       RETURNING id`,
      [
        person.organizationId,
        person.memberId,
        conversationId,
        input.tool ?? 'email_send',
        input.risk ?? 'danger',
        input.reversible ?? false,
        input.itemCount ?? 1,
        input.autoConfirmed ?? false,
        input.undoOf ?? null,
        input.expiresIn ?? '24 hours',
      ],
    );
    return rows[0]!.id;
  });
}

function update(person: Person, table: string, set: string, where: string, params: unknown[] = []) {
  return asTenant(app, person, (c) => c.query(`UPDATE ${table} SET ${set} WHERE ${where}`, params)).catch((e: unknown) => e);
}

async function statusOf(person: Person, id: string): Promise<string | undefined> {
  return asTenant(app, person, async (c) => {
    const { rows } = await c.query<{ status: string }>(`SELECT status::text AS status FROM agent_actions WHERE id = $1`, [id]);
    return rows[0]?.status;
  });
}

async function connect(person: Person, provider = 'gmail'): Promise<string> {
  return asTenant(app, person, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO connections (organization_id, member_id, provider, name, transport, server_url)
       VALUES ($1, $2, $3, 'Mail', 'mcp_http', $4) RETURNING id`,
      [person.organizationId, person.memberId, provider, `https://mcp.example.com/${randomBytes(4).toString('hex')}`],
    );
    await c.query(
      `INSERT INTO connection_secrets (connection_id, organization_id, member_id, key_version, iv, tag, ciphertext)
       VALUES ($1, $2, $3, 1, $4, $5, $6)`,
      [rows[0]!.id, person.organizationId, person.memberId, randomBytes(12), randomBytes(16), randomBytes(40)],
    );
    return rows[0]!.id;
  });
}

beforeAll(async () => {
  const [adaId, graceId, linusId] = [await user('ada'), await user('grace'), await user('linus')];
  const { rows } = await platform.query<{ id: string }>(
    `INSERT INTO organizations (name, kind, owner_user_id) VALUES ('Shared', 'shared', $1) RETURNING id`,
    [adaId],
  );
  ada = await member(rows[0]!.id, adaId, 'owner');
  grace = await member(rows[0]!.id, graceId, 'member');
  const own = await platform.query<{ id: string }>(
    `INSERT INTO organizations (name, kind, owner_user_id) VALUES ('Linus', 'personal', $1) RETURNING id`,
    [linusId],
  );
  linus = await member(own.rows[0]!.id, linusId, 'owner');
  adaConversation = await conversation(ada);
  graceConversation = await conversation(grace);
});

afterAll(async () => {
  await platform.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${suffix}@actions.test`]);
  await Promise.all([app.end(), platform.end(), owner.end()]);
});

// ──────────────────────────────────────────────────────────────── proposals

describe('a proposal', () => {
  it('is made proposed, with nothing done, and is the proposer’s alone', async () => {
    const id = await propose(ada, adaConversation);
    expect(await statusOf(ada, id)).toBe('proposed');
    expect(await statusOf(grace, id)).toBeUndefined();
    expect(await statusOf(linus, id)).toBeUndefined();
    const early = await asTenant(app, ada, (c) =>
      c.query(
        `INSERT INTO agent_actions (organization_id, member_id, conversation_id, tool, args, preview, risk, reversible, reason, status)
         VALUES ($1, $2, $3, 'email_send', '{}', '{}', 'danger', false, 'x', 'running')`,
        [ada.organizationId, ada.memberId, adaConversation],
      ),
    ).catch((e: unknown) => e);
    expect(hintOf(early)).toBe('agent_action_transition');
  });

  it('cannot be made in another person’s conversation', async () => {
    const error = await asTenant(app, ada, (c) =>
      c.query(
        `INSERT INTO agent_actions (organization_id, member_id, conversation_id, tool, args, preview, risk, reversible, reason)
         VALUES ($1, $2, $3, 'email_send', '{}', '{}', 'danger', false, 'x')`,
        [ada.organizationId, ada.memberId, graceConversation],
      ),
    ).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('23503');
  });

  it('never runs an irreversible or danger-class call without a person', async () => {
    for (const input of [
      { risk: 'danger' as const, reversible: true },
      { risk: 'caution' as const, reversible: false },
    ]) {
      const error = await propose(ada, adaConversation, { ...input, autoConfirmed: true }).catch((e: unknown) => e);
      expect(hintOf(error)).toBe('agent_action_needs_person');
    }
    // Reversible caution work may run as it is made, in auto mode.
    const auto = await propose(ada, adaConversation, { tool: 'calendar_create_event', risk: 'caution', reversible: true, autoConfirmed: true });
    expect(await statusOf(ada, auto)).toBe('proposed');
  });

  it('is an offer for a day at most', async () => {
    const error = await propose(ada, adaConversation, { expiresIn: '25 hours' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
  });

  it('does not change what it proposes once made — not even for its owner', async () => {
    const id = await propose(ada, adaConversation);
    expect(String(await update(ada, 'agent_actions', `args = '{"to":"eve@example.com"}'`, 'id = $1', [id]))).toMatch(/permission denied/);
    const asOwner = await asTenant(owner, ada, (c) =>
      c.query(`UPDATE agent_actions SET args = '{"to":"eve@example.com"}' WHERE id = $1`, [id]),
    ).catch((e: unknown) => e);
    expect(hintOf(asOwner)).toBe('agent_action_immutable');
  });

  it('runs at most once: proposed → running → completed, and no further', async () => {
    const id = await propose(ada, adaConversation);
    await update(ada, 'agent_actions', `status = 'running'`, 'id = $1', [id]);
    const again = await update(ada, 'agent_actions', `status = 'running'`, 'id = $1 AND true', [id]);
    expect(again).not.toBeInstanceOf(Error);
    await update(ada, 'agent_actions', `processed = 1, claimed_through = 1, succeeded = 1`, 'id = $1', [id]);
    await update(ada, 'agent_actions', `status = 'completed'`, 'id = $1', [id]);
    expect(await statusOf(ada, id)).toBe('completed');
    for (const next of ['running', 'proposed', 'failed']) {
      expect(hintOf(await update(ada, 'agent_actions', `status = '${next}'`, 'id = $1', [id]))).toBe('agent_action_transition');
    }
    const stamped = await asTenant(app, ada, async (c) => {
      const { rows } = await c.query<{ confirmed_at: Date | null; finished_at: Date | null }>(
        `SELECT confirmed_at, finished_at FROM agent_actions WHERE id = $1`,
        [id],
      );
      return rows[0]!;
    });
    expect(stamped.confirmed_at).not.toBeNull();
    expect(stamped.finished_at).not.toBeNull();
  });

  it('is not confirmed after its day, and expires only once its day is over', async () => {
    const id = await propose(ada, adaConversation, { expiresIn: '1 second' });
    expect(hintOf(await update(ada, 'agent_actions', `status = 'expired'`, 'id = $1', [id]))).toBe('agent_action_transition');
    await new Promise((r) => setTimeout(r, 1100));
    expect(hintOf(await update(ada, 'agent_actions', `status = 'running'`, 'id = $1', [id]))).toBe('agent_action_expired');
    // The hourly pass, as the platform role.
    await platform.query(`UPDATE agent_actions SET status = 'expired' WHERE id = $1`, [id]);
    expect(await statusOf(ada, id)).toBe('expired');
  });

  it('may be discarded while it waits, and only then', async () => {
    const id = await propose(ada, adaConversation);
    await update(ada, 'agent_actions', `status = 'discarded'`, 'id = $1', [id]);
    expect(await statusOf(ada, id)).toBe('discarded');
    expect(hintOf(await update(ada, 'agent_actions', `status = 'running'`, 'id = $1', [id]))).toBe('agent_action_transition');
  });

  it('moves its progress only forward, and only while it runs', async () => {
    const id = await propose(ada, adaConversation, { itemCount: 3 });
    expect(hintOf(await update(ada, 'agent_actions', `claimed_through = 1`, 'id = $1', [id]))).toBe('agent_action_transition');
    await update(ada, 'agent_actions', `status = 'running'`, 'id = $1', [id]);
    await update(ada, 'agent_actions', `claimed_through = 2, processed = 2, succeeded = 1, uncertain = 1`, 'id = $1', [id]);
    expect(hintOf(await update(ada, 'agent_actions', `uncertain = 0`, 'id = $1', [id]))).toBe('agent_action_transition');
    const overrun = await update(ada, 'agent_actions', `claimed_through = 4`, 'id = $1', [id]);
    expect((overrun as { constraint?: string }).constraint).toBe('agent_actions_progress');
  });

  it('is undone by a new proposal that names a completed one of one’s own', async () => {
    const done = await propose(ada, adaConversation, { tool: 'calendar_create_event', risk: 'caution', reversible: true });
    const pending = await propose(ada, adaConversation, { tool: 'calendar_create_event', risk: 'caution', reversible: true });
    await update(ada, 'agent_actions', `status = 'running'`, 'id = $1', [done]);
    await update(ada, 'agent_actions', `status = 'completed'`, 'id = $1', [done]);
    const undo = await propose(ada, adaConversation, { tool: 'calendar_delete_event', undoOf: done });
    expect(await statusOf(ada, undo)).toBe('proposed');
    expect(hintOf(await propose(ada, adaConversation, { undoOf: pending }).catch((e: unknown) => e))).toBe('agent_action_undo_invalid');
    // Grace cannot undo Ada's, even naming it.
    expect(hintOf(await propose(grace, graceConversation, { undoOf: done }).catch((e: unknown) => e))).toBe('agent_action_undo_invalid');
  });
});

// ──────────────────────────────────────────────────────────────────── items

describe('an action’s items', () => {
  async function withItems(n: number): Promise<string> {
    const id = await propose(ada, adaConversation, { itemCount: n });
    await asTenant(app, ada, async (c) => {
      for (let seq = 1; seq <= n; seq += 1) {
        await c.query(
          `INSERT INTO agent_action_items (action_id, seq, organization_id, member_id, input) VALUES ($1, $2, $3, $4, $5)`,
          [id, seq, ada.organizationId, ada.memberId, JSON.stringify({ n: seq })],
        );
      }
    });
    return id;
  }

  it('run once each: a claimed item ends succeeded, failed or uncertain — never back to pending', async () => {
    const id = await withItems(2);
    await update(ada, 'agent_action_items', `status = 'running'`, 'action_id = $1 AND seq = 1', [id]);
    expect(hintOf(await update(ada, 'agent_action_items', `status = 'pending'`, 'action_id = $1 AND seq = 1', [id]))).toBe(
      'agent_action_item_once',
    );
    await update(ada, 'agent_action_items', `status = 'uncertain', error = 'interrupted'`, 'action_id = $1 AND seq = 1', [id]);
    for (const next of ['running', 'pending', 'succeeded']) {
      expect(hintOf(await update(ada, 'agent_action_items', `status = '${next}'`, 'action_id = $1 AND seq = 1', [id]))).toBe(
        'agent_action_item_once',
      );
    }
    // A pending one cannot be declared done without running.
    expect(hintOf(await update(ada, 'agent_action_items', `status = 'succeeded'`, 'action_id = $1 AND seq = 2', [id]))).toBe(
      'agent_action_item_once',
    );
  });

  it('keep their input as it was proposed', async () => {
    const id = await withItems(1);
    expect(String(await update(ada, 'agent_action_items', `input = '{"n":99}'`, 'action_id = $1', [id]))).toMatch(/permission denied/);
  });

  it('are invisible to anyone else', async () => {
    const id = await withItems(1);
    const seen = await asTenant(app, grace, (c) => c.query(`SELECT 1 FROM agent_action_items WHERE action_id = $1`, [id]));
    expect(seen.rowCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────── connections

describe('a connection', () => {
  it('is one person’s, with its secrets', async () => {
    const id = await connect(ada);
    const graceSees = await asTenant(app, grace, (c) => c.query(`SELECT 1 FROM connection_secrets WHERE connection_id = $1`, [id]));
    expect(graceSees.rowCount).toBe(0);
    const linusSees = await asTenant(app, linus, (c) => c.query(`SELECT 1 FROM connections WHERE id = $1`, [id]));
    expect(linusSees.rowCount).toBe(0);
  });

  it('loses its secrets the moment it is revoked, and stays revoked', async () => {
    const id = await connect(ada);
    await update(ada, 'connections', `status = 'revoked'`, 'id = $1', [id]);
    const secrets = await asTenant(app, ada, (c) => c.query(`SELECT 1 FROM connection_secrets WHERE connection_id = $1`, [id]));
    expect(secrets.rowCount).toBe(0);
    expect(hintOf(await update(ada, 'connections', `status = 'active'`, 'id = $1', [id]))).toBe('connection_revoked');
    const reinsert = await asTenant(app, ada, (c) =>
      c.query(
        `INSERT INTO connection_secrets (connection_id, organization_id, member_id, key_version, iv, tag, ciphertext)
         VALUES ($1, $2, $3, 1, $4, $5, $6)`,
        [id, ada.organizationId, ada.memberId, randomBytes(12), randomBytes(16), randomBytes(8)],
      ),
    ).catch((e: unknown) => e);
    expect(hintOf(reinsert)).toBe('connection_revoked');
  });

  it('cannot have its secrets deleted directly by the application', async () => {
    const id = await connect(ada);
    expect(String(await asTenant(app, ada, (c) => c.query(`DELETE FROM connection_secrets WHERE connection_id = $1`, [id])).catch((e: unknown) => e))).toMatch(
      /permission denied/,
    );
  });

  it('does not change what it connects to', async () => {
    const id = await connect(ada);
    const error = await asTenant(owner, ada, (c) => c.query(`UPDATE connections SET server_url = 'https://evil.example' WHERE id = $1`, [id])).catch(
      (e: unknown) => e,
    );
    expect(hintOf(error)).toBe('connection_identity_fixed');
  });

  it('is HTTPS only, and an MCP connection names its server', async () => {
    const error = await asTenant(app, ada, (c) =>
      c.query(
        `INSERT INTO connections (organization_id, member_id, provider, name, transport, server_url)
         VALUES ($1, $2, 'custom', 'X', 'mcp_http', 'http://mcp.example.com')`,
        [ada.organizationId, ada.memberId],
      ),
    ).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('23514');
  });

  it('leaves a proposal that used it pointing nowhere when it is deleted — the proposal then fails at confirm', async () => {
    const connectionId = await connect(ada, 'notion');
    const id = await asTenant(app, ada, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO agent_actions (organization_id, member_id, conversation_id, connection_id, tool, args, preview, risk, reversible, reason)
         VALUES ($1, $2, $3, $4, 'notion_create_page', '{}', '{}', 'caution', true, 'x') RETURNING id`,
        [ada.organizationId, ada.memberId, adaConversation, connectionId],
      );
      return rows[0]!.id;
    });
    await asTenant(owner, ada, (c) => c.query(`DELETE FROM connections WHERE id = $1`, [connectionId]));
    const after = await asTenant(app, ada, (c) => c.query<{ connection_id: string | null }>(`SELECT connection_id FROM agent_actions WHERE id = $1`, [id]));
    expect(after.rows[0]!.connection_id).toBeNull();
  });
});

describe('an OAuth authorization in flight', () => {
  async function state(person: Person, expiresIn = '10 minutes'): Promise<string> {
    return asTenant(app, person, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO connection_oauth_states (organization_id, member_id, state_hash, provider, key_version, iv, tag, ciphertext, expires_at)
         VALUES ($1, $2, $3, 'gmail', 1, $4, $5, $6, now() + $7::interval) RETURNING id`,
        [person.organizationId, person.memberId, randomBytes(32).toString('hex'), randomBytes(12), randomBytes(16), randomBytes(43), expiresIn],
      );
      return rows[0]!.id;
    });
  }

  it('is used once', async () => {
    const id = await state(ada);
    await update(ada, 'connection_oauth_states', 'used_at = now()', 'id = $1', [id]);
    expect(hintOf(await update(ada, 'connection_oauth_states', 'used_at = now()', 'id = $1', [id]))).toBe('oauth_state_used');
  });

  it('lives ten minutes at most, and is refused after', async () => {
    expect(await state(ada, '11 minutes').catch((e: unknown) => e)).toBeInstanceOf(Error);
    const id = await state(ada, '1 second');
    await new Promise((r) => setTimeout(r, 1100));
    expect(hintOf(await update(ada, 'connection_oauth_states', 'used_at = now()', 'id = $1', [id]))).toBe('oauth_state_expired');
  });
});

// ───────────────────────────────────────────────────────── sandbox and files

describe('a sandbox run', () => {
  it('records its duration when it ends, and is a record after', async () => {
    const id = await asTenant(app, ada, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO sandbox_sessions (organization_id, member_id, conversation_id, provider, runtime)
         VALUES ($1, $2, $3, 'local', 'python') RETURNING id`,
        [ada.organizationId, ada.memberId, adaConversation],
      );
      return rows[0]!.id;
    });
    await update(ada, 'sandbox_sessions', `status = 'succeeded', exit_code = 0`, 'id = $1', [id]);
    const row = await asTenant(app, ada, async (c) => (await c.query<{ duration_ms: number }>(`SELECT duration_ms FROM sandbox_sessions WHERE id = $1`, [id])).rows[0]!);
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    expect(hintOf(await update(ada, 'sandbox_sessions', `exit_code = 1`, 'id = $1', [id]))).toBe('sandbox_session_finished');
  });
});

describe('a file the agent made', () => {
  it('is kept at most ninety days, with a safe name, and only for its person', async () => {
    const insert = (person: Person, name: string, keep = '30 days') =>
      asTenant(app, person, (c) =>
        c.query(
          `INSERT INTO agent_files (organization_id, member_id, conversation_id, name, content_type, bytes, sha256, source, expires_at)
           VALUES ($1, $2, $3, $4, 'text/csv', 'a,b', $5, 'file_create', now() + $6::interval) RETURNING id`,
          [person.organizationId, person.memberId, adaConversation, name, 'a'.repeat(64), keep],
        ),
      ).catch((e: unknown) => e);
    expect(await insert(ada, 'report.csv')).not.toBeInstanceOf(Error);
    expect(await insert(ada, '../etc/passwd')).toBeInstanceOf(Error);
    expect(await insert(ada, 'report.csv', '120 days')).toBeInstanceOf(Error);
    // Not in someone else's conversation.
    expect((await insert(grace, 'report.csv')) as { code?: string }).toMatchObject({ code: '23503' });
    expect(String(await asTenant(app, ada, (c) => c.query(`DELETE FROM agent_files`)).catch((e: unknown) => e))).toMatch(/permission denied/);
  });
});
