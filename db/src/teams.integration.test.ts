import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { APP_URL, OWNER_URL, PLATFORM_URL, asTenant, hintOf } from './testing.js';

/**
 * The rules 0012_teams enforces: one lead and one reviewer per team; a run's
 * life, its fixed identity and its growing spend, sealed when finished; a
 * task graph without cycles, contracts that never change, an interrupted task
 * run again only as a new attempt; an append-only step log; team memory that
 * names one of the person's teams; all of it one person's.
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
    `${name}-${suffix}@teams.test`,
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

const run = <T>(p: Person, fn: (c: pg.PoolClient) => Promise<T>) => asTenant(app, p, fn);
const attempt = (p: Person, sql: string, params: unknown[]) => run(p, (c) => c.query(sql, params)).catch((e: unknown) => e);

async function agent(p: Person, name = 'Member'): Promise<string> {
  return run(p, async (c) => {
    const { rows } = await c.query<{ id: string }>(`INSERT INTO agents (organization_id, member_id, name) VALUES ($1, $2, $3) RETURNING id`, [
      p.organizationId,
      p.memberId,
      name,
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

async function team(p: Person): Promise<string> {
  return run(p, async (c) => {
    const { rows } = await c.query<{ id: string }>(`INSERT INTO teams (organization_id, member_id, name) VALUES ($1, $2, 'Desk') RETURNING id`, [
      p.organizationId,
      p.memberId,
    ]);
    return rows[0]!.id;
  });
}

async function newRun(p: Person, input: { parent?: string; teamId?: string } = {}): Promise<string> {
  return run(p, async (c) => {
    const conv = await c.query<{ id: string }>(
      `INSERT INTO agent_conversations (organization_id, member_id, title, model) VALUES ($1, $2, 'Run', 'm') RETURNING id`,
      [p.organizationId, p.memberId],
    );
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO runs (organization_id, member_id, parent_run_id, team_id, conversation_id, goal, budget_tokens)
       VALUES ($1, $2, $3, $4, $5, 'Research the market', 50000) RETURNING id`,
      [p.organizationId, p.memberId, input.parent ?? null, input.teamId ?? null, conv.rows[0]!.id],
    );
    return rows[0]!.id;
  });
}

const setStatus = (p: Person, id: string, status: string, extra = '') =>
  attempt(p, `UPDATE runs SET status = $2${extra} WHERE id = $1`, [id, status]);

async function task(p: Person, runId: string, key: string, dependsOn: string[] = []): Promise<unknown> {
  return attempt(
    p,
    `INSERT INTO run_tasks (organization_id, member_id, run_id, key, title, goal, depends_on) VALUES ($1, $2, $3, $4, $4, 'Do it', $5)`,
    [p.organizationId, p.memberId, runId, key, dependsOn],
  );
}

const taskStatus = (p: Person, runId: string, key: string, status: string, extra = '') =>
  attempt(p, `UPDATE run_tasks SET status = $3${extra} WHERE run_id = $1 AND key = $2`, [runId, key, status]);

beforeAll(async () => {
  ada = await person('ada');
  grace = await person('grace', ada.organizationId);
});

afterAll(async () => {
  await platform.query(`DELETE FROM organizations WHERE id = $1`, [ada.organizationId]);
  await platform.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${suffix}@teams.test`]);
  await Promise.all([app.end(), platform.end(), owner.end()]);
});

describe('a team', () => {
  it('has one lead and at most one reviewer', async () => {
    const t = await team(ada);
    const [a, b, c] = [await agent(ada, 'A'), await agent(ada, 'B'), await agent(ada, 'C')];
    const add = (agentId: string, role: string) =>
      attempt(ada, `INSERT INTO team_members (organization_id, member_id, team_id, agent_id, role) VALUES ($1, $2, $3, $4, $5)`, [
        ada.organizationId,
        ada.memberId,
        t,
        agentId,
        role,
      ]);
    expect(await add(a, 'lead')).toMatchObject({ rowCount: 1 });
    expect((await add(b, 'lead')) as { code?: string }).toMatchObject({ code: '23505' });
    expect(await add(b, 'reviewer')).toMatchObject({ rowCount: 1 });
    expect((await add(c, 'reviewer')) as { code?: string }).toMatchObject({ code: '23505' });
    expect(await add(c, 'member')).toMatchObject({ rowCount: 1 });
    expect((await add(c, 'member')) as { code?: string }).toMatchObject({ code: '23505' });
  });

  it('is one person’s, and names only their agents', async () => {
    const t = await team(ada);
    expect((await run(grace, (c) => c.query(`SELECT 1 FROM teams WHERE id = $1`, [t]))).rowCount).toBe(0);
    const theirs = await agent(grace);
    const foreign = await attempt(ada, `INSERT INTO team_members (organization_id, member_id, team_id, agent_id, role) VALUES ($1, $2, $3, $4, 'member')`, [
      ada.organizationId,
      ada.memberId,
      t,
      theirs,
    ]);
    expect((foreign as { code?: string }).code).toBe('23503');
  });
});

describe('a run', () => {
  it('starts queued, and moves only along its state machine', async () => {
    const forged = await run(ada, async (c) => {
      const conv = await c.query<{ id: string }>(
        `INSERT INTO agent_conversations (organization_id, member_id, title, model) VALUES ($1, $2, 'Run', 'm') RETURNING id`,
        [ada.organizationId, ada.memberId],
      );
      return c
        .query(
          `INSERT INTO runs (organization_id, member_id, conversation_id, goal, budget_tokens, status) VALUES ($1, $2, $3, 'x', 5000, 'completed')`,
          [ada.organizationId, ada.memberId, conv.rows[0]!.id],
        )
        .catch((e: unknown) => e);
    });
    expect(hintOf(forged)).toBe('run_transition');
    const id = await newRun(ada);
    expect(hintOf(await setStatus(ada, id, 'completed', `, result = 'x'`))).toBe('run_transition');
    expect(await setStatus(ada, id, 'running')).toMatchObject({ rowCount: 1 });
    expect(await setStatus(ada, id, 'waiting_approval')).toMatchObject({ rowCount: 1 });
    expect(hintOf(await setStatus(ada, id, 'failed'))).toBe('run_transition');
    expect(await setStatus(ada, id, 'running')).toMatchObject({ rowCount: 1 });
    expect(hintOf(await setStatus(ada, id, 'completed'))).toBe('run_transition');
    expect(await setStatus(ada, id, 'completed', `, result = 'The answer'`)).toMatchObject({ rowCount: 1 });
    const { rows } = await run(ada, (c) => c.query<{ started_at: Date; finished_at: Date }>(`SELECT started_at, finished_at FROM runs WHERE id = $1`, [id]));
    expect(rows[0]!.started_at).toBeInstanceOf(Date);
    expect(rows[0]!.finished_at).toBeInstanceOf(Date);
  });

  it('is sealed once completed or cancelled — not even the schema owner changes it', async () => {
    const id = await newRun(ada);
    await setStatus(ada, id, 'cancelled');
    expect(hintOf(await setStatus(ada, id, 'running'))).toBe('run_finished');
    const asOwner = await asTenant(owner, ada, (c) => c.query(`UPDATE runs SET result = 'x' WHERE id = $1`, [id])).catch((e: unknown) => e);
    expect(hintOf(asOwner)).toBe('run_finished');
    expect(String(await attempt(ada, `DELETE FROM runs WHERE id = $1`, [id]))).toMatch(/permission denied/);
  });

  it('may be taken up again after failing, by a person’s rerun', async () => {
    const id = await newRun(ada);
    await setStatus(ada, id, 'running');
    await setStatus(ada, id, 'failed', `, error = 'task t1 was interrupted'`);
    expect(await setStatus(ada, id, 'running')).toMatchObject({ rowCount: 1 });
    const { rows } = await run(ada, (c) => c.query<{ finished_at: Date | null }>(`SELECT finished_at FROM runs WHERE id = $1`, [id]));
    expect(rows[0]!.finished_at).toBeNull();
  });

  it('keeps what it is, and what it spent only grows', async () => {
    const id = await newRun(ada);
    expect(String(await attempt(ada, `UPDATE runs SET goal = 'Something else' WHERE id = $1`, [id]))).toMatch(/permission denied/);
    const asOwner = await asTenant(owner, ada, (c) => c.query(`UPDATE runs SET goal = 'Else' WHERE id = $1`, [id])).catch((e: unknown) => e);
    expect(hintOf(asOwner)).toBe('run_identity_fixed');
    await attempt(ada, `UPDATE runs SET spent_tokens = 900 WHERE id = $1`, [id]);
    expect(hintOf(await attempt(ada, `UPDATE runs SET spent_tokens = 100 WHERE id = $1`, [id]))).toBe('run_spend_backwards');
  });

  it('nests at most two deep, its depth set by the database', async () => {
    const root = await newRun(ada);
    const child = await newRun(ada, { parent: root });
    const grandchild = await newRun(ada, { parent: child });
    const { rows } = await run(ada, (c) => c.query<{ depth: number }>(`SELECT depth FROM runs WHERE id = ANY($1::text[]) ORDER BY depth`, [[root, child, grandchild]]));
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
    expect(hintOf(await newRun(ada, { parent: grandchild }).catch((e: unknown) => e))).toBe('run_too_deep');
  });

  it('is one person’s', async () => {
    const id = await newRun(ada);
    expect((await run(grace, (c) => c.query(`SELECT 1 FROM runs WHERE id = $1`, [id]))).rowCount).toBe(0);
    expect((await setStatus(grace, id, 'cancelled')) as pg.QueryResult).toMatchObject({ rowCount: 0 });
  });
});

describe('a run’s tasks', () => {
  it('form a graph without cycles: a task depends only on earlier tasks of the run', async () => {
    const id = await newRun(ada);
    expect(await task(ada, id, 't1')).toMatchObject({ rowCount: 1 });
    expect(await task(ada, id, 't2', ['t1'])).toMatchObject({ rowCount: 1 });
    expect(hintOf(await task(ada, id, 't3', ['t4']))).toBe('task_dependency_unknown');
    expect(hintOf(await task(ada, id, 't3', ['t3']))).toBe('task_dependency_unknown');
    const other = await newRun(ada);
    await task(ada, other, 'x1');
    expect(hintOf(await task(ada, id, 't5', ['x1']))).toBe('task_dependency_unknown');
  });

  it('keep their contract, finish with an output, and stay done', async () => {
    const id = await newRun(ada);
    await task(ada, id, 't1');
    const asOwner = await asTenant(owner, ada, (c) => c.query(`UPDATE run_tasks SET goal = 'Other' WHERE run_id = $1`, [id])).catch((e: unknown) => e);
    expect(hintOf(asOwner)).toBe('task_contract_fixed');
    expect(hintOf(await taskStatus(ada, id, 't1', 'done', `, output = 'x'`))).toBe('task_transition');
    await taskStatus(ada, id, 't1', 'running');
    expect(hintOf(await taskStatus(ada, id, 't1', 'done'))).toBe('task_transition');
    expect(await taskStatus(ada, id, 't1', 'done', `, output = 'Found three'`)).toMatchObject({ rowCount: 1 });
    expect(hintOf(await attempt(ada, `UPDATE run_tasks SET output = 'Changed' WHERE run_id = $1`, [id]))).toBe('task_transition');
  });

  it('are run again after an interruption only as a new attempt', async () => {
    const id = await newRun(ada);
    await task(ada, id, 't1');
    await taskStatus(ada, id, 't1', 'running');
    await taskStatus(ada, id, 't1', 'uncertain', `, error = 'interrupted'`);
    expect(hintOf(await taskStatus(ada, id, 't1', 'pending'))).toBe('task_transition');
    expect(hintOf(await taskStatus(ada, id, 't1', 'running'))).toBe('task_transition');
    expect(await taskStatus(ada, id, 't1', 'pending', ', attempts = attempts + 1')).toMatchObject({ rowCount: 1 });
    const { rows } = await run(ada, (c) => c.query<{ error: string | null; attempts: number }>(`SELECT error, attempts FROM run_tasks WHERE run_id = $1`, [id]));
    expect(rows[0]).toEqual({ error: null, attempts: 1 });
  });

  it('are reassigned only while they wait', async () => {
    const id = await newRun(ada);
    const [a, b] = [await agent(ada, 'A'), await agent(ada, 'B')];
    await attempt(ada, `INSERT INTO run_tasks (organization_id, member_id, run_id, key, title, goal, assigned_agent_id) VALUES ($1, $2, $3, 't1', 't1', 'Do it', $4)`, [
      ada.organizationId,
      ada.memberId,
      id,
      a,
    ]);
    await taskStatus(ada, id, 't1', 'running');
    expect(hintOf(await attempt(ada, `UPDATE run_tasks SET assigned_agent_id = $2 WHERE run_id = $1`, [id, b]))).toBe('task_transition');
    await taskStatus(ada, id, 't1', 'failed', `, error = 'model failed'`);
    expect(await attempt(ada, `UPDATE run_tasks SET status = 'pending', attempts = attempts + 1, assigned_agent_id = $2 WHERE run_id = $1`, [id, b])).toMatchObject({
      rowCount: 1,
    });
  });

  it('do not change once their run is finished', async () => {
    const id = await newRun(ada);
    await task(ada, id, 't1');
    await setStatus(ada, id, 'cancelled');
    expect(hintOf(await taskStatus(ada, id, 't1', 'running'))).toBe('run_finished');
    expect(hintOf(await task(ada, id, 't2'))).toBe('run_finished');
  });
});

describe('a run’s steps', () => {
  it('are numbered by the database and never changed', async () => {
    const id = await newRun(ada);
    for (const summary of ['Planned three tasks', 'Assigned t1']) {
      await attempt(ada, `INSERT INTO run_steps (organization_id, member_id, run_id, seq, kind, summary) VALUES ($1, $2, $3, 99, 'plan', $4)`, [
        ada.organizationId,
        ada.memberId,
        id,
        summary,
      ]);
    }
    const { rows } = await run(ada, (c) => c.query<{ seq: number }>(`SELECT seq FROM run_steps WHERE run_id = $1 ORDER BY seq`, [id]));
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(String(await attempt(ada, `UPDATE run_steps SET summary = 'x' WHERE run_id = $1`, [id]))).toMatch(/permission denied/);
    const asOwner = await asTenant(owner, ada, (c) => c.query(`DELETE FROM run_steps WHERE run_id = $1`, [id])).catch((e: unknown) => e);
    expect(hintOf(asOwner)).toBe('run_step_immutable');
  });
});

describe('team memory', () => {
  const hash = () => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const remember = (p: Person, ref: string) =>
    attempt(
      p,
      `INSERT INTO memory_items (organization_id, member_id, scope, scope_ref, content, tier, state, source_kind, actor, evidence_hash)
       VALUES ($1, $2, 'team', $3, 'The market grew', 'T4', 'pending', 'subagent', 'agent', $4) RETURNING id`,
      [p.organizationId, p.memberId, ref, hash()],
    );

  it('names one of the person’s teams', async () => {
    expect(await remember(ada, await team(ada))).toMatchObject({ rowCount: 1 });
    expect(hintOf(await remember(ada, await team(grace)))).toBe('memory_scope_unknown');
    expect(hintOf(await remember(ada, await agent(ada)))).toBe('memory_scope_unknown');
  });
});
