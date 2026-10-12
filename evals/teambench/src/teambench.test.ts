import type { RunView } from '@milyonuse/contracts';
import { describe, expect, it } from 'vitest';
import { TEAM_BENCH, report, scoreRun } from './index.js';

const at = (s: number) => new Date(Date.UTC(2026, 9, 12, 9, 0, s)).toISOString();

/** A run that did everything right, for a case. */
function goodRun(id: string): RunView {
  const bench = TEAM_BENCH.find((b) => b.id === id)!;
  return {
    id: 'r',
    teamId: 't',
    agentId: null,
    automationId: null,
    conversationId: 'c',
    goal: bench.goal,
    mode: bench.mode,
    status: 'completed',
    budgetTokens: bench.budgetTokens,
    spentTokens: 1000,
    createdAt: at(0),
    finishedAt: at(59),
    result: bench.plan.map((t) => t.finding).join(', '),
    error: null,
    revisions: 0,
    tasks: bench.plan.map((t, i) => ({
      id: `k${i}`,
      key: t.key,
      title: t.title,
      goal: t.goal,
      context: '',
      successCriteria: '',
      dependsOn: t.dependsOn ?? [],
      assignedAgentId: null,
      status: 'done' as const,
      attempts: 0,
      output: t.finding,
      error: null,
      tokens: 100,
      startedAt: at((t.dependsOn?.length ? 10 : 1) + i),
      finishedAt: at((t.dependsOn?.length ? 20 : 5) + i),
    })),
    steps: bench.team.reviewer ? [{ seq: 1, kind: 'review' as const, taskKey: null, agentId: null, summary: 'ok', tokens: 0, createdAt: at(30) }] : [],
    members: [],
    proposals: 0,
  };
}

describe('the cases', () => {
  it('are ten, with unique ids, across the three ways of working', () => {
    expect(TEAM_BENCH).toHaveLength(10);
    expect(new Set(TEAM_BENCH.map((b) => b.id)).size).toBe(10);
    expect(new Set(TEAM_BENCH.map((b) => b.mode))).toEqual(new Set(['hierarchical', 'pipeline', 'debate']));
  });

  it.each(TEAM_BENCH.map((b) => [b.id, b] as const))('%s has a valid reference plan', (_id, b) => {
    const team = [b.team.lead, ...b.team.members];
    const seen = new Set<string>();
    for (const t of b.plan) {
      expect(team, `${t.assignee} is not on the team`).toContain(t.assignee);
      for (const d of t.dependsOn ?? []) expect(seen.has(d), `${t.key} depends on ${d} before it`).toBe(true);
      expect(seen.has(t.key)).toBe(false);
      seen.add(t.key);
      expect(t.finding.length).toBeGreaterThan(2);
    }
    if (b.mode === 'debate') expect(b.team.members.length).toBeGreaterThanOrEqual(2);
    for (const f of b.failing ?? []) expect(b.team.members).toContain(f);
  });
});

describe('scoreRun', () => {
  it('passes a run that did everything right', () => {
    for (const b of TEAM_BENCH) expect(scoreRun(b, goodRun(b.id)).passed, b.id).toBe(true);
  });

  it('fails a run that did not complete, or left a task undone', () => {
    const b = TEAM_BENCH[0]!;
    const failed = { ...goodRun(b.id), status: 'failed' as const, error: 'Task t1 failed twice' };
    expect(scoreRun(b, failed).checks.find((c) => c.name === 'completed')).toMatchObject({ passed: false, detail: 'ended failed: Task t1 failed twice' });
    const run = goodRun(b.id);
    run.tasks[1]!.status = 'failed';
    expect(scoreRun(b, run).checks.find((c) => c.name === 'tasks_done')!.passed).toBe(false);
  });

  it('fails a task started before its inputs finished', () => {
    const b = TEAM_BENCH.find((x) => x.id === 'market-sizing')!;
    const run = goodRun(b.id);
    run.tasks[2]!.startedAt = at(2);
    expect(scoreRun(b, run).checks.find((c) => c.name === 'order')).toMatchObject({ passed: false, detail: 'started before their inputs: t3' });
  });

  it('fails a result that dropped a finding, a team that skipped its reviewer, a run over budget', () => {
    const b = TEAM_BENCH.find((x) => x.id === 'hiring-brief')!;
    const run = { ...goodRun(b.id), result: 'responsibilities only', steps: [], spentTokens: b.budgetTokens + 1 };
    const failed = scoreRun(b, run).checks.filter((c) => !c.passed).map((c) => c.name);
    expect(failed.sort()).toEqual(['budget', 'findings', 'reviewed']);
  });

  it('reports the pass rate and what failed', () => {
    const scores = TEAM_BENCH.map((b) => scoreRun(b, goodRun(b.id)));
    scores[0] = scoreRun(TEAM_BENCH[0]!, { ...goodRun(TEAM_BENCH[0]!.id), result: '' });
    const r = report(scores);
    expect(r).toMatchObject({ cases: 10, passed: 9, passRate: 0.9 });
    expect(r.failures[0]!.checks[0]).toMatch(/^findings: the result misses/);
  });
});
