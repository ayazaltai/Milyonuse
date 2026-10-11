import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { APP_URL, OWNER_URL, PLATFORM_URL, asTenant, hintOf } from './testing.js';

/**
 * The rules 0007_memory enforces, as the application role that meets them:
 * nothing written straight into memory, no source claiming more trust than it
 * has, sealed provenance, the lifecycle, independent confirmation, approval,
 * re-promotion on new evidence only, the operator's review gap, revocation
 * through derivations, and a ledger that only grows and shows any tampering.
 */

const app = new pg.Pool({ connectionString: APP_URL, max: 3 });
const platform = new pg.Pool({ connectionString: PLATFORM_URL, max: 2 });
const owner = new pg.Pool({ connectionString: OWNER_URL, max: 2 });
const suffix = Date.now().toString(36);

const PASSWORD_HASH =
  'scrypt$15$8$3$qAJmqqKLyfYY7Z9RM6y3qQ$LuwxjHraHT_UDEhntpNf9xhQWa2rg1CV2PEWHg6eUCLhCCXRcDQY5ukct94f5eqPpJjWYYYaaVrHNbHATJTB7w';

interface Person {
  organizationId: string;
  memberId: string;
}

let ada: Person;
let grace: Person;

const evidence = () => createHash('sha256').update(randomBytes(16)).digest('hex');

async function person(name: string): Promise<Person> {
  const { rows } = await platform.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`, [
    `${name}-${suffix}@memory.test`,
    name,
  ]);
  const userId = rows[0]!.id;
  await platform.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`, [userId, PASSWORD_HASH]);
  const org = await platform.query<{ id: string }>(
    `INSERT INTO organizations (name, kind, owner_user_id) VALUES ($1, 'personal', $2) RETURNING id`,
    [name, userId],
  );
  const member = await platform.query<{ id: string }>(
    `INSERT INTO members (organization_id, user_id, role) VALUES ($1, $2, 'owner') RETURNING id`,
    [org.rows[0]!.id, userId],
  );
  return { organizationId: org.rows[0]!.id, memberId: member.rows[0]!.id };
}

interface Candidate {
  tier?: string;
  source?: string;
  uri?: string | null;
  state?: string;
  content?: string;
}

/** A candidate, as the pipeline writes one. */
async function propose(who: Person, c: Candidate = {}): Promise<string> {
  return asTenant(app, who, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO memory_items (organization_id, member_id, content, tier, state, source_kind, source_uri, actor, evidence_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'agent', $8) RETURNING id`,
      [
        who.organizationId,
        who.memberId,
        c.content ?? `A fact ${randomBytes(4).toString('hex')}`,
        c.tier ?? 'T2',
        c.state ?? 'pending',
        c.source ?? 'agent_observed',
        c.uri ?? null,
        evidence(),
      ],
    );
    return rows[0]!.id;
  });
}

async function update(who: Person, id: string, set: string, params: unknown[] = []): Promise<unknown> {
  return asTenant(app, who, (client) => client.query(`UPDATE memory_items SET ${set} WHERE id = $1`, [id, ...params])).catch(
    (e: unknown) => e,
  );
}

async function stateOf(who: Person, id: string): Promise<string> {
  return asTenant(app, who, async (client) => {
    const { rows } = await client.query<{ state: string }>(`SELECT state FROM memory_items WHERE id = $1`, [id]);
    return rows[0]?.state ?? 'invisible';
  });
}

async function confirm(who: Person, id: string, uri: string | null, hash = evidence()): Promise<unknown> {
  return asTenant(app, who, (client) =>
    client.query(
      `INSERT INTO memory_confirmations (organization_id, item_id, evidence_hash, source_kind, source_uri)
       VALUES ($1, $2, $3, 'third_party', $4)`,
      [who.organizationId, id, hash, uri],
    ),
  ).catch((e: unknown) => e);
}

beforeAll(async () => {
  ada = await person('ada');
  grace = await person('grace');
});

afterAll(async () => {
  await platform.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${suffix}@memory.test`]);
  await Promise.all([app.end(), platform.end(), owner.end()]);
});

describe('a person’s memory', () => {
  it('is theirs alone', async () => {
    const id = await propose(ada);
    expect(await stateOf(grace, id)).toBe('invisible');
    const { rowCount } = await asTenant(app, ada.organizationId, (c) => c.query(`SELECT 1 FROM memory_items WHERE id = $1`, [id]));
    expect(rowCount).toBe(0);
  });

  it('cannot be written into another organization', async () => {
    await expect(
      asTenant(app, ada, (c) =>
        c.query(
          `INSERT INTO memory_items (organization_id, member_id, content, tier, state, source_kind, actor, evidence_hash)
           VALUES ($1, $2, 'x', 'T2', 'pending', 'agent_observed', 'agent', $3)`,
          [grace.organizationId, grace.memberId, evidence()],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('writing', () => {
  it('never lands in active: a candidate is pending', async () => {
    const error = await propose(ada, { state: 'active' }).catch((e: unknown) => e);
    expect(hintOf(error)).toBe('memory_direct_write');
  });

  it('never claims more trust than its source has', async () => {
    expect(hintOf(await propose(ada, { tier: 'T1', source: 'agent_observed' }).catch((e: unknown) => e))).toBe(
      'memory_tier_exceeds_source',
    );
    expect(hintOf(await propose(ada, { tier: 'T2', source: 'third_party' }).catch((e: unknown) => e))).toBe(
      'memory_tier_exceeds_source',
    );
    // Less trust than the source allows is always allowed.
    expect(await stateOf(ada, await propose(ada, { tier: 'T4', source: 'third_party' }))).toBe('pending');
  });

  it('seals content and provenance — for the application, and for the schema owner too', async () => {
    const id = await propose(ada);
    // The application role holds no right to these columns at all.
    expect(String(await update(ada, id, `content = 'rewritten'`))).toMatch(/permission denied/);
    const error = await asTenant(owner, ada, (c) =>
      c.query(`UPDATE memory_items SET tier = 'T1' WHERE id = $1`, [id]),
    ).catch((e: unknown) => e);
    expect(hintOf(error)).toBe('memory_provenance_immutable');
  });

  it('cannot be deleted by the application', async () => {
    const id = await propose(ada);
    await expect(asTenant(app, ada, (c) => c.query(`DELETE FROM memory_items WHERE id = $1`, [id]))).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('the lifecycle', () => {
  it('promotes a verified agent observation, and ledgers each step', async () => {
    const id = await propose(ada);
    expect(await update(ada, id, `state = 'active', verdict = 'passed'`)).toMatchObject({ rowCount: 1 });
    const actions = await asTenant(app, ada, async (c) =>
      (await c.query<{ action: string }>(`SELECT action FROM memory_ledger WHERE item_id = $1 ORDER BY seq`, [id])).rows.map(
        (r) => r.action,
      ),
    );
    expect(actions).toEqual(['ingest', 'promote']);
  });

  it('allows only the lifecycle’s moves, and keeps rejected and revoked final', async () => {
    const id = await propose(ada);
    expect(hintOf(await update(ada, id, `state = 'demoted'`))).toBe('memory_transition_invalid');
    await update(ada, id, `state = 'rejected', state_reason = 'scanner flagged'`);
    expect(hintOf(await update(ada, id, `state = 'active'`))).toBe('memory_transition_invalid');
    const other = await propose(ada);
    await update(ada, other, `state = 'revoked'`);
    expect(hintOf(await update(ada, other, `state = 'pending'`))).toBe('memory_transition_invalid');
  });

  it('promotes a third-party claim only on two independent confirmations', async () => {
    const claimEvidence = evidence();
    const id = await asTenant(app, ada, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO memory_items (organization_id, member_id, content, tier, state, source_kind, source_uri, actor, evidence_hash)
         VALUES ($1, $2, 'Lisbon trams cost 3 euros', 'T3', 'pending', 'third_party', 'web:a.example', 'agent', $3) RETURNING id`,
        [ada.organizationId, ada.memberId, claimEvidence],
      );
      return rows[0]!.id;
    });
    expect(hintOf(await update(ada, id, `state = 'active'`))).toBe('memory_confirmations_required');
    // Processing the same claim again, or its own source, is no confirmation.
    expect(hintOf(await confirm(ada, id, 'web:b.example', claimEvidence))).toBe('memory_confirmation_not_independent');
    expect(hintOf(await confirm(ada, id, 'web:a.example'))).toBe('memory_confirmation_not_independent');
    expect(await confirm(ada, id, 'web:b.example')).toMatchObject({ rowCount: 1 });
    // One source, once.
    expect((await confirm(ada, id, 'web:b.example')) as { code?: string }).toMatchObject({ code: '23505' });
    expect(hintOf(await update(ada, id, `state = 'active'`))).toBe('memory_confirmations_required');
    await confirm(ada, id, 'mail:c.example');
    expect(await update(ada, id, `state = 'active'`)).toMatchObject({ rowCount: 1 });
  });

  it('promotes an unknown claim only on the person’s approval', async () => {
    const id = await propose(ada, { tier: 'T4', source: 'unknown' });
    expect(hintOf(await update(ada, id, `state = 'active'`))).toBe('memory_approval_required');
    await update(ada, id, `state = 'active', approved_at = now(), approved_by = $2`, [ada.memberId]);
    expect(await stateOf(ada, id)).toBe('active');
    const { rows } = await asTenant(app, ada, (c) =>
      c.query<{ action: string }>(`SELECT action FROM memory_ledger WHERE item_id = $1 ORDER BY seq DESC LIMIT 1`, [id]),
    );
    expect(rows[0]!.action).toBe('approve');
  });

  it('brings a demoted memory back only on new evidence, under a lower ceiling', async () => {
    const id = await propose(ada);
    await update(ada, id, `state = 'active'`);
    await update(ada, id, `state = 'demoted', state_reason = 'trust decayed'`);
    // A demotion cannot be simply undone (Agent 5.5's loop).
    expect(hintOf(await update(ada, id, `state = 'active'`))).toBe('memory_repromotion_requires_evidence');
    // A reaffirmation, but at the same ceiling: still no.
    expect(
      hintOf(await update(ada, id, `state = 'active', reaffirm_count = 1, last_reaffirmed_at = clock_timestamp()`)),
    ).toBe('memory_repromotion_requires_evidence');
    await update(ada, id, `state = 'active', reaffirm_count = 1, last_reaffirmed_at = clock_timestamp(), trust_ceiling = 0.8`);
    expect(await stateOf(ada, id)).toBe('active');
  });

  it('activates an operator’s claim with a second signature, and not before its review gap', async () => {
    const id = await asTenant(app, ada.organizationId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO memory_items (organization_id, content, tier, state, source_kind, actor, evidence_hash, signature, key_fingerprint)
         VALUES ($1, 'Never share account passwords', 'T0', 't0_staged', 'operator', 'operator', $2, 'c2ln', 'sha256:abc')
         RETURNING id`,
        [ada.organizationId, evidence()],
      );
      return rows[0]!.id;
    });
    const early = await asTenant(app, ada.organizationId, (c) =>
      c.query(`UPDATE memory_items SET state = 'active', activation_signature = 'c2ln' WHERE id = $1`, [id]),
    ).catch((e: unknown) => e);
    expect(hintOf(early)).toBe('memory_t0_review');
    // Everyone in the organization reads it; the person sees it too.
    expect(await stateOf(ada, id)).toBe('t0_staged');
  });

  it('refuses an operator claim with no signature', async () => {
    const error = await asTenant(app, ada.organizationId, (c) =>
      c.query(
        `INSERT INTO memory_items (organization_id, content, tier, state, source_kind, actor, evidence_hash)
         VALUES ($1, 'x', 'T0', 't0_staged', 'operator', 'operator', $2)`,
        [ada.organizationId, evidence()],
      ),
    ).catch((e: unknown) => e);
    expect((error as { constraint?: string }).constraint).toBe('memory_items_operator');
  });
});

describe('revocation', () => {
  it('follows a source through three levels of derivation, in well under a second', async () => {
    const uri = `attachment:${randomBytes(6).toString('hex')}`;
    const direct = await propose(ada, { tier: 'T3', source: 'third_party', uri });
    const read = await propose(ada, { tier: 'T3', source: 'third_party', uri: 'attachment:elsewhere' });
    const second = await propose(ada);
    const third = await propose(ada);
    const untouched = await propose(ada);
    await asTenant(app, ada, async (c) => {
      const edge = (item: string, parent: string | null, source: string | null) =>
        c.query(
          `INSERT INTO memory_derivations (organization_id, item_id, parent_item_id, source_uri) VALUES ($1, $2, $3, $4)`,
          [ada.organizationId, item, parent, source],
        );
      await edge(read, null, uri);
      await edge(second, read, null);
      await edge(third, second, null);
    });
    const started = Date.now();
    const revoked = await asTenant(app, ada, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `UPDATE memory_items SET state = 'revoked', state_reason = 'source withdrawn'
          WHERE id IN (SELECT id FROM app.memory_revocation_set($1, NULL)) RETURNING id`,
        [uri],
      );
      return rows.map((r) => r.id).sort();
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(revoked).toEqual([direct, read, second, third].sort());
    expect(await stateOf(ada, untouched)).toBe('pending');
  });

  it('is scoped: a source in someone else’s memory is not theirs to revoke', async () => {
    const uri = `web:${randomBytes(6).toString('hex')}`;
    const theirs = await propose(grace, { tier: 'T3', source: 'third_party', uri });
    const set = await asTenant(app, ada, async (c) =>
      (await c.query(`SELECT id FROM app.memory_revocation_set($1, NULL)`, [uri])).rowCount,
    );
    expect(set).toBe(0);
    expect(await stateOf(grace, theirs)).toBe('pending');
  });
});

describe('the ledger', () => {
  it('chains every entry, per organization, and verifies whole', async () => {
    await propose(grace);
    const result = await asTenant(app, grace, async (c) => {
      const { rows } = await c.query<{ broken_seq: string | null; checked: string }>(`SELECT * FROM app.memory_ledger_verify()`);
      return rows[0]!;
    });
    expect(result.broken_seq).toBeNull();
    expect(Number(result.checked)).toBeGreaterThan(0);
  });

  it('is written only by the database: the application cannot append, change or remove an entry', async () => {
    await expect(
      asTenant(app, ada, (c) => c.query(`SELECT app.memory_ledger_append($1, 'promote', NULL, '{}')`, [ada.organizationId])),
    ).rejects.toThrow(/permission denied/);
    await expect(asTenant(app, ada, (c) => c.query(`UPDATE memory_ledger SET action = 'x'`))).rejects.toThrow(/permission denied/);
    await expect(asTenant(app, ada, (c) => c.query(`DELETE FROM memory_ledger`))).rejects.toThrow(/permission denied/);
  });

  it('refuses a change even from the schema owner', async () => {
    const error = await asTenant(owner, ada.organizationId, (c) => c.query(`UPDATE memory_ledger SET action = 'forged'`)).catch(
      (e: unknown) => e,
    );
    expect(hintOf(error)).toBe('memory_ledger_immutable');
  });

  it('shows a tampered line: the chain breaks at it', async () => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [ada.organizationId]);
      // Only the owner can switch the guard off, and only inside this transaction, which is rolled back.
      await client.query('ALTER TABLE memory_ledger DISABLE TRIGGER memory_ledger_no_update');
      await client.query(
        `UPDATE memory_ledger SET detail = '{"tier":"T1"}' WHERE seq = (SELECT min(seq) + 1 FROM memory_ledger)`,
      );
      const { rows } = await client.query<{ broken_seq: string | null }>(`SELECT * FROM app.memory_ledger_verify()`);
      expect(rows[0]!.broken_seq).not.toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('what a turn read, and what was rejected', () => {
  it('records a turn’s outside sources once each, for its person only', async () => {
    const conversation = await asTenant(app, ada, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO agent_conversations (organization_id, member_id, model) VALUES ($1, $2, 'm/x') RETURNING id`,
        [ada.organizationId, ada.memberId],
      );
      return rows[0]!.id;
    });
    const run = '01J0000000000000000000000Z';
    const write = () =>
      asTenant(app, ada, (c) =>
        c.query(
          `INSERT INTO run_taint (organization_id, member_id, conversation_id, run_id, source_kind, source_uri)
           VALUES ($1, $2, $3, $4, 'third_party', 'attachment:1')`,
          [ada.organizationId, ada.memberId, conversation, run],
        ),
      );
    await write();
    await expect(write()).rejects.toThrow(/run_taint_once/);
    const seen = await asTenant(app, grace, async (c) => (await c.query(`SELECT 1 FROM run_taint`)).rowCount);
    expect(seen).toBe(0);
  });

  it('keeps rejected ideas as they were', async () => {
    await asTenant(app, ada, (c) =>
      c.query(`INSERT INTO memory_negative (organization_id, member_id, content, reason) VALUES ($1, $2, 'x', 'injection')`, [
        ada.organizationId,
        ada.memberId,
      ]),
    );
    await expect(asTenant(app, ada, (c) => c.query(`UPDATE memory_negative SET reason = 'fine'`))).rejects.toThrow(
      /permission denied/,
    );
  });

  it('recalls by vector among active memory', async () => {
    const vector = (hot: number) => `[${Array.from({ length: 1536 }, (_, i) => (i === hot ? 1 : 0)).join(',')}]`;
    const near = await propose(ada, { content: 'near' });
    const far = await propose(ada, { content: 'far' });
    for (const [id, hot] of [
      [near, 1],
      [far, 2],
    ] as const) {
      await update(ada, id, `state = 'active', embedding = $2::vector, embedding_model = 'test-1536'`, [vector(hot)]);
    }
    const order = await asTenant(app, ada, async (c) =>
      (
        await c.query<{ content: string }>(
          `SELECT content FROM memory_items WHERE state = 'active' AND embedding_model = 'test-1536'
            ORDER BY embedding <=> $1::vector LIMIT 2`,
          [vector(1)],
        )
      ).rows.map((r) => r.content),
    );
    expect(order).toEqual(['near', 'far']);
  });
});
