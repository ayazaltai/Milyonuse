import type { RunView } from '@milyonuse/contracts';
import type { BenchCase } from './tasks.js';

/**
 * How a TeamBench run is scored: structural checks any good run passes,
 * whoever planned it. A deterministic run must pass all of them; a live run's
 * pass rate is the number to watch as the engine and prompts change.
 */

export interface BenchCheck {
  name: 'completed' | 'tasks_done' | 'order' | 'budget' | 'reviewed' | 'findings' | 'proportionate';
  passed: boolean;
  detail: string;
}

export interface BenchScore {
  id: string;
  passed: boolean;
  checks: BenchCheck[];
}

/** Steps a run of this size should need at most, before it is spinning. */
export const STEPS_PER_TASK = 6;

export function scoreRun(bench: BenchCase, run: RunView): BenchScore {
  const done = run.tasks.filter((t) => t.status === 'done');
  const finishedAt = new Map(run.tasks.map((t) => [t.key, t.finishedAt]));
  const outOfOrder = run.tasks.filter((t) =>
    t.dependsOn.some((d) => {
      const before = finishedAt.get(d);
      return !before || !t.startedAt || before > t.startedAt;
    }),
  );
  const result = (run.result ?? '').toLocaleLowerCase('en');
  const missing = bench.plan.map((t) => t.finding).filter((f) => !result.includes(f.toLocaleLowerCase('en')));
  const reviewed = run.steps.some((s) => s.kind === 'review');
  const checks: BenchCheck[] = [
    { name: 'completed', passed: run.status === 'completed', detail: `ended ${run.status}${run.error ? `: ${run.error}` : ''}` },
    {
      name: 'tasks_done',
      passed: run.tasks.length > 0 && done.length === run.tasks.length,
      detail: `${done.length} of ${run.tasks.length} task(s) done`,
    },
    { name: 'order', passed: outOfOrder.length === 0, detail: outOfOrder.length ? `started before their inputs: ${outOfOrder.map((t) => t.key).join(', ')}` : 'every task after its inputs' },
    { name: 'budget', passed: run.spentTokens <= run.budgetTokens, detail: `${run.spentTokens} of ${run.budgetTokens} tokens` },
    {
      name: 'reviewed',
      passed: !bench.team.reviewer || reviewed,
      detail: bench.team.reviewer ? (reviewed ? 'reviewed before delivery' : 'delivered without review') : 'no reviewer on the team',
    },
    { name: 'findings', passed: missing.length === 0, detail: missing.length ? `the result misses: ${missing.join(', ')}` : 'every finding reached the result' },
    {
      name: 'proportionate',
      passed: run.steps.length <= Math.max(10, run.tasks.length * STEPS_PER_TASK),
      detail: `${run.steps.length} step(s) for ${run.tasks.length} task(s)`,
    },
  ];
  return { id: bench.id, passed: checks.every((c) => c.passed), checks };
}

export interface BenchReport {
  cases: number;
  passed: number;
  passRate: number;
  failures: { id: string; checks: string[] }[];
}

export function report(scores: readonly BenchScore[]): BenchReport {
  const passed = scores.filter((s) => s.passed).length;
  return {
    cases: scores.length,
    passed,
    passRate: scores.length === 0 ? 0 : passed / scores.length,
    failures: scores
      .filter((s) => !s.passed)
      .map((s) => ({ id: s.id, checks: s.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`) })),
  };
}
