import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunView, StudioAgentView, TeamView } from '@milyonuse/contracts';
import { type BenchCase, type BenchScore, TEAM_BENCH, report, scoreRun } from '@milyonuse/teambench';
import { PLATFORM_URL } from './database/database.testing.js';
import { AGENT_MODEL, type AgentModel, AgentModelError, type AgentModelResult } from './modules/agent/agent-model.port.js';
import { JobWorker } from './modules/queue/job.worker.js';
import { type TestApp, createTestApp, lastMail, sessionOf, tokenIn } from './testing/test-app.js';

/**
 * TeamBench, draft (F5 §4.4), run end to end through the engine: each case's
 * team is built, given its goal, advanced by the queue and scored. The model
 * is deterministic — the lead plans the reference plan, each member reports
 * its finding and carries forward what it was given, the lead merges, the
 * reviewer approves — so every case must pass: this checks the engine and the
 * harness, not a model. The same cases run against a live model score how
 * well it leads a team.
 */

const suffix = Date.now().toString(36);
const platform = new pg.Pool({ connectionString: PLATFORM_URL, max: 2 });
const MODEL = 'anthropic/claude-sonnet-5-5';
let current: BenchCase;

const reply = (text: string, call?: { name: string; args: Record<string, unknown> }): AgentModelResult => ({
  text,
  toolCalls: call ? [{ id: `c_${Math.random().toString(36).slice(2, 8)}`, name: call.name, arguments: JSON.stringify(call.args) }] : [],
  finishReason: call ? 'tool_calls' : 'stop',
  usage: { input: 300, output: 60, cached: 0, costUsd: null },
  servedModel: MODEL,
});

const bench: AgentModel = {
  name: 'openrouter',
  complete(request) {
    const { system } = request;
    const name = /— Agent profile[^\n]*\nYou are ([^,.\n]+)/.exec(system)?.[1]?.trim() ?? '?';
    const input = request.messages.find((m) => m.role === 'user')?.content ?? '';
    if (system.includes('— Team run: you lead —')) {
      return Promise.resolve(
        reply('', {
          name: 'plan_tasks',
          args: { tasks: current.plan.map((t) => ({ key: t.key, title: t.title, goal: t.goal, assignee: t.assignee, depends_on: t.dependsOn ?? [] })) },
        }),
      );
    }
    if (system.includes('— Team run: you merge —')) {
      const outputs = [...input.matchAll(/<<<data [0-9a-f]+ · [^\n]*\n([\s\S]*?)\n>>>data/g)].map((m) => m[1]);
      return Promise.resolve(reply('', { name: 'merge_results', args: { result: outputs.join('\n') } }));
    }
    if (system.includes('— Team run: you review —')) return Promise.resolve(reply('', { name: 'approve_result', args: {} }));
    if (system.includes('— Team run: you take one task —')) {
      if (current.failing?.includes(name)) return Promise.reject(new AgentModelError('rate_limited', 'The model is busy right now.'));
      const key = /^Task (\w+)/.exec(input)?.[1];
      const own = current.plan.find((t) => t.key === key)?.finding ?? '';
      // What a stage was given, it carries forward — a pipeline's result is its last stage.
      const carried = current.plan.filter((t) => t.key !== key && input.includes(t.finding)).map((t) => t.finding);
      return Promise.resolve(reply([own, ...carried].join('; ')));
    }
    return Promise.resolve(reply('Hello.'));
  },
};

let api: TestApp;
let cookie: string;

async function agent(name: string): Promise<StudioAgentView> {
  const response = await api.request('POST', '/agents', { cookie, payload: { name } });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<StudioAgentView>();
}

async function runCase(c: BenchCase): Promise<{ run: RunView; score: BenchScore }> {
  current = c;
  const lead = await agent(c.team.lead);
  const members = [];
  for (const m of c.team.members) members.push(await agent(m));
  const reviewer = c.team.reviewer ? await agent(c.team.reviewer) : null;
  const team = await api.request('POST', '/teams', {
    cookie,
    payload: {
      name: c.id,
      mode: c.mode,
      budgetTokens: c.budgetTokens,
      members: [
        { agentId: lead.id, role: 'lead', position: 0 },
        ...members.map((m, i) => ({ agentId: m.id, role: 'member', position: i + 1 })),
        ...(reviewer ? [{ agentId: reviewer.id, role: 'reviewer', position: 9 }] : []),
      ],
    },
  });
  expect(team.statusCode, team.body).toBe(201);
  const started = await api.request('POST', `/teams/${team.json<TeamView>().id}/runs`, { cookie, payload: { goal: c.goal } });
  expect(started.statusCode, started.body).toBe(201);
  const worker = api.app.get(JobWorker);
  for (let i = 0; i < 20; i += 1) if ((await worker.drain(1)) === 0) break;
  const run = (await api.request('GET', `/runs/${started.json<RunView>().id}`, { cookie })).json<RunView>();
  return { run, score: scoreRun(c, run) };
}

beforeAll(async () => {
  api = await createTestApp({ AGENT_MODEL: MODEL, AGENT_MODELS: MODEL }, [{ provide: AGENT_MODEL, useValue: bench }]);
  await platform.query(`UPDATE jobs SET status = 'cancelled', finished_at = now() WHERE status IN ('queued', 'running')`);
  const email = `bench-${suffix}@teambench.e2e.test`;
  await api.request('POST', '/auth/register', { payload: { name: 'Bench', email, password: 'correct horse battery staple', acceptTerms: true } });
  cookie = sessionOf(await api.request('POST', '/auth/verify', { payload: { token: tokenIn(lastMail(api.outbox, email), 'verify') } }))!;
}, 90_000);

afterAll(async () => {
  await api?.close();
  await platform.end();
});

describe('TeamBench (draft, deterministic)', () => {
  const scores: BenchScore[] = [];

  it.each(TEAM_BENCH.map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    const { run, score } = await runCase(c);
    scores.push(score);
    expect(score.checks.filter((x) => !x.passed), JSON.stringify({ status: run.status, error: run.error, result: run.result })).toEqual([]);
    if (c.failing?.length) expect(run.steps.some((s) => s.kind === 'assign' && /failed/.test(s.summary))).toBe(true);
  });

  it('passes every case', () => {
    expect(report(scores)).toMatchObject({ cases: 10, passed: 10, passRate: 1 });
  });
});
