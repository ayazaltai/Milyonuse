import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { APP_URL, OWNER_URL, PLATFORM_URL, asTenant, hintOf } from './testing.js';

/**
 * The rules 0010_studio enforces: an agent version is a numbered snapshot
 * that never changes, and an agent's current version is its own; a skill
 * enters staging (a bundled one active), never becomes active without a
 * passing replay and an approval, never at all when the scanner said danger;
 * replay evidence is append-only; all of it is one person's.
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

async function person(name: string, organizationId?: string): Promise<Person> {
  const { rows: user } = await platform.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`, [
    `${name}-${suffix}@studio.test`,
    name,
  ]);
  let org = organizationId;
  if (!org) {
    const { rows } = await platform.query<{ id: string }>(
      `INSERT INTO organizations (name, kind, owner_user_id) VALUES ($1, 'shared', $2) RETURNING id`,
      [name, user[0]!.id],
    );
    org = rows[0]!.id;
  }
  const { rows } = await platform.query<{ id: string }>(`INSERT INTO members (organization_id, user_id) VALUES ($1, $2) RETURNING id`, [
    org,
    user[0]!.id,
  ]);
  return { organizationId: org, memberId: rows[0]!.id };
}

async function agent(p: Person, persona = 'Curious'): Promise<{ id: string; versionId: string }> {
  return asTenant(app, p, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO agents (organization_id, member_id, name) VALUES ($1, $2, 'Ada the Researcher') RETURNING id`,
      [p.organizationId, p.memberId],
    );
    const id = rows[0]!.id;
    const v = await c.query<{ id: string }>(
      `INSERT INTO agent_versions (organization_id, member_id, agent_id, persona) VALUES ($1, $2, $3, $4) RETURNING id`,
      [p.organizationId, p.memberId, id, persona],
    );
    await c.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [id, v.rows[0]!.id]);
    return { id, versionId: v.rows[0]!.id };
  });
}

async function skill(p: Person, input: { source?: string; state?: string; verdict?: string; derivedFrom?: string[] } = {}): Promise<string> {
  return asTenant(app, p, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO skills (organization_id, member_id, name, source) VALUES ($1, $2, $3, $4) RETURNING id`,
      [p.organizationId, p.memberId, `s-${Math.random().toString(36).slice(2, 10)}`, input.source ?? 'learned'],
    );
    const v = await c.query<{ id: string }>(
      `INSERT INTO skill_versions (organization_id, member_id, skill_id, state, description, content, scan_verdict, derived_from)
       VALUES ($1, $2, $3, $4, 'Does a thing', '---\nname: x\n---\nbody', $5, $6) RETURNING id`,
      [p.organizationId, p.memberId, rows[0]!.id, input.state ?? 'staging', input.verdict ?? 'clean', input.derivedFrom ?? []],
    );
    return v.rows[0]!.id;
  });
}

function update(p: Person, sql: string, params: unknown[]) {
  return asTenant(app, p, (c) => c.query(sql, params)).catch((e: unknown) => e);
}

async function replay(p: Person, versionId: string, passed: boolean): Promise<void> {
  await asTenant(app, p, (c) =>
    c.query(
      `INSERT INTO skill_runs (organization_id, member_id, skill_version_id, passed, score, evaluator, verdict)
       VALUES ($1, $2, $3, $4, $5, 'rules', 'checked')`,
      [p.organizationId, p.memberId, versionId, passed, passed ? 0.9 : 0.2],
    ),
  );
}

beforeAll(async () => {
  ada = await person('ada');
  grace = await person('grace', ada.organizationId);
});

afterAll(async () => {
  await platform.query(`DELETE FROM organizations WHERE id = $1`, [ada.organizationId]);
  await platform.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${suffix}@studio.test`]);
  await Promise.all([app.end(), platform.end(), owner.end()]);
});

describe('an agent version', () => {
  it('is numbered by the database, one after the last, whatever the writer says', async () => {
    const { id } = await agent(ada);
    const versions = await asTenant(app, ada, async (c) => {
      for (const n of [7, 1]) {
        await c.query(`INSERT INTO agent_versions (organization_id, member_id, agent_id, version, persona) VALUES ($1, $2, $3, $4, 'x')`, [
          ada.organizationId,
          ada.memberId,
          id,
          n,
        ]);
      }
      return (await c.query<{ version: number }>(`SELECT version FROM agent_versions WHERE agent_id = $1 ORDER BY version`, [id])).rows.map((r) => r.version);
    });
    expect(versions).toEqual([1, 2, 3]);
  });

  it('never changes — not even for the schema owner — and is not deleted on its own', async () => {
    const { versionId } = await agent(ada);
    expect(String(await update(ada, `UPDATE agent_versions SET persona = 'Rude' WHERE id = $1`, [versionId]))).toMatch(/permission denied/);
    const asOwner = await asTenant(owner, ada, (c) => c.query(`UPDATE agent_versions SET persona = 'Rude' WHERE id = $1`, [versionId])).catch((e: unknown) => e);
    expect(hintOf(asOwner)).toBe('agent_version_immutable');
    const deleted = await asTenant(owner, ada, (c) => c.query(`DELETE FROM agent_versions WHERE id = $1`, [versionId])).catch((e: unknown) => e);
    expect(hintOf(deleted)).toBe('agent_version_immutable');
  });

  it('goes with its agent when the agent goes', async () => {
    const { id, versionId } = await agent(ada);
    await asTenant(owner, ada, (c) => c.query(`DELETE FROM agents WHERE id = $1`, [id]));
    const left = await asTenant(app, ada, (c) => c.query(`SELECT 1 FROM agent_versions WHERE id = $1`, [versionId]));
    expect(left.rowCount).toBe(0);
  });

  it('is current only for its own agent', async () => {
    const one = await agent(ada);
    const two = await agent(ada);
    const error = await update(ada, `UPDATE agents SET current_version_id = $2 WHERE id = $1`, [one.id, two.versionId]);
    expect(hintOf(error)).toBe('agent_version_foreign');
  });

  it('is one person’s: a colleague in the same organization sees nothing', async () => {
    const { id } = await agent(ada);
    expect((await asTenant(app, grace, (c) => c.query(`SELECT 1 FROM agents WHERE id = $1`, [id]))).rowCount).toBe(0);
    expect((await asTenant(app, grace, (c) => c.query(`SELECT 1 FROM agent_versions WHERE agent_id = $1`, [id]))).rowCount).toBe(0);
  });

  it('is named on the answers it wrote, and an old answer keeps the old version (acceptance 1)', async () => {
    const { id, versionId: first } = await agent(ada, 'First');
    const conversation = await asTenant(app, ada, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO agent_conversations (organization_id, member_id, model, agent_id) VALUES ($1, $2, 'anthropic/claude-sonnet-5-5', $3) RETURNING id`,
        [ada.organizationId, ada.memberId, id],
      );
      await c.query(
        `INSERT INTO agent_messages (organization_id, conversation_id, role, content, agent_version_id) VALUES ($1, $2, 'assistant', 'hello', $3)`,
        [ada.organizationId, rows[0]!.id, first],
      );
      const second = await c.query<{ id: string }>(
        `INSERT INTO agent_versions (organization_id, member_id, agent_id, persona) VALUES ($1, $2, $3, 'Second') RETURNING id`,
        [ada.organizationId, ada.memberId, id],
      );
      await c.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [id, second.rows[0]!.id]);
      return rows[0]!.id;
    });
    const { rows } = await asTenant(app, ada, (c) =>
      c.query<{ persona: string }>(
        `SELECT v.persona FROM agent_messages m JOIN agent_versions v ON v.id = m.agent_version_id WHERE m.conversation_id = $1`,
        [conversation],
      ),
    );
    expect(rows[0]!.persona).toBe('First');
  });
});

describe('a skill version', () => {
  it('enters staging; only a bundled one enters active', async () => {
    expect(hintOf(await skill(ada, { state: 'active' }).catch((e: unknown) => e))).toBe('skill_replay_required');
    const bundled = await skill(ada, { source: 'bundled', state: 'active' });
    expect(bundled).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('becomes active only after a passing replay, and only with an approval (acceptance 2)', async () => {
    const id = await skill(ada);
    const approve = (sql = `UPDATE skill_versions SET state = 'active', approved_at = now(), approved_by = $2 WHERE id = $1`) =>
      update(ada, sql, [id, ada.memberId]);
    expect(hintOf(await approve())).toBe('skill_replay_required');
    await replay(ada, id, false);
    expect(hintOf(await approve())).toBe('skill_replay_required');
    await replay(ada, id, true);
    expect(hintOf(await update(ada, `UPDATE skill_versions SET state = 'active' WHERE id = $1 AND $2::ulid IS NOT NULL`, [id, ada.memberId]))).toBe(
      'skill_approval_required',
    );
    expect(await approve()).not.toBeInstanceOf(Error);
  });

  it('rated danger by the scanner is never active, whatever passed', async () => {
    const id = await skill(ada, { verdict: 'danger' });
    await replay(ada, id, true);
    const error = await update(ada, `UPDATE skill_versions SET state = 'active', approved_at = now() WHERE id = $1`, [id]);
    expect(hintOf(error)).toBe('skill_danger');
    expect(hintOf(await skill(ada, { source: 'bundled', state: 'active', verdict: 'danger' }).catch((e: unknown) => e))).toBe('skill_danger');
  });

  it('keeps what it says and where it came from sealed', async () => {
    const id = await skill(ada, { derivedFrom: ['https://a.example'] });
    const error = await asTenant(owner, ada, (c) => c.query(`UPDATE skill_versions SET derived_from = '{}' WHERE id = $1`, [id])).catch((e: unknown) => e);
    expect(hintOf(error)).toBe('skill_version_immutable');
  });

  it('moves only forward: a revoked or rejected version stays so', async () => {
    const id = await skill(ada);
    await update(ada, `UPDATE skill_versions SET state = 'rejected', state_reason = 'no' WHERE id = $1`, [id]);
    expect(hintOf(await update(ada, `UPDATE skill_versions SET state = 'staging' WHERE id = $1`, [id]))).toBe('skill_transition_invalid');
  });

  it('falls with a source it was derived from — in one statement', async () => {
    const uri = `https://poison-${suffix}.example/page`;
    const tainted = await skill(ada, { derivedFrom: [uri] });
    const clean = await skill(ada, { derivedFrom: ['https://elsewhere.example'] });
    const { rows } = await asTenant(app, ada, (c) =>
      c.query<{ id: string }>(`UPDATE skill_versions SET state = 'revoked' WHERE state IN ('staging', 'active') AND $1 = ANY (derived_from) RETURNING id`, [uri]),
    );
    expect(rows.map((r) => r.id)).toEqual([tainted]);
    expect(rows.map((r) => r.id)).not.toContain(clean);
  });
});

describe('replay evidence', () => {
  it('is appended, never changed or removed', async () => {
    const id = await skill(ada);
    await replay(ada, id, true);
    expect(String(await update(ada, `UPDATE skill_runs SET passed = false WHERE skill_version_id = $1`, [id]))).toMatch(/permission denied/);
    const asOwner = await asTenant(owner, ada, (c) => c.query(`UPDATE skill_runs SET passed = false WHERE skill_version_id = $1`, [id])).catch((e: unknown) => e);
    expect(hintOf(asOwner)).toBe('skill_run_immutable');
  });

  it('is one person’s', async () => {
    const id = await skill(ada);
    await replay(ada, id, true);
    expect((await asTenant(app, grace, (c) => c.query(`SELECT 1 FROM skill_runs WHERE skill_version_id = $1`, [id]))).rowCount).toBe(0);
    const forged = await asTenant(app, grace, (c) =>
      c.query(
        `INSERT INTO skill_runs (organization_id, member_id, skill_version_id, passed, evaluator, verdict) VALUES ($1, $2, $3, true, 'rules', 'x')`,
        [grace.organizationId, grace.memberId, id],
      ),
    ).catch((e: unknown) => e);
    expect((forged as { code?: string }).code).toBe('23503');
  });
});
