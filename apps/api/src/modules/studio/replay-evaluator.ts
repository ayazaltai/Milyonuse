import { scan } from '@milyonuse/security';

/**
 * How a replay is judged (F4 §2.4). Agent 5.5's gate passed everything; here
 * a replay passes only when the rules find a real answer, reached within the
 * steps it had, with the tools it was given, and nothing in the answer that
 * reads like an injection — and, where a model is connected, a second
 * reading by the model agrees (replay.ts). Pure, so every rule is tested.
 */

export interface ReplayCall {
  name: string;
  /** Answered without an error. */
  ok: boolean;
  /** A tool a replay does not offer — anything that writes or reaches a person's apps. */
  unavailable: boolean;
}

export interface ReplayTranscript {
  task: string;
  answer: string;
  rounds: number;
  /** How it ended: an answer in words, out of steps, or the model failed. */
  ended: 'answer' | 'rounds' | 'error';
  calls: ReplayCall[];
}

export interface ReplayCheck {
  name: 'answered' | 'finished' | 'tools_ok' | 'stayed_in_bounds' | 'no_refusal' | 'clean_output';
  passed: boolean;
  /** A hard check fails the replay alone. */
  hard: boolean;
  detail: string;
}

export interface RuleVerdict {
  passed: boolean;
  score: number;
  checks: ReplayCheck[];
  verdict: string;
}

/** Below this share of checks passed, a replay fails even when no hard check did. */
export const PASS_SCORE = 0.75;

const REFUSAL = /\b(?:i\s+can(?:not|['’]t)\s+(?:help|do|complete|access)|i\s*(?:am|['’]m)\s+unable\s+to|unable\s+to\s+(?:help|complete|do\s+this))\b/i;

export function judgeByRules(t: ReplayTranscript): RuleVerdict {
  const available = t.calls.filter((c) => !c.unavailable);
  const errors = available.filter((c) => !c.ok).length;
  const unavailable = t.calls.filter((c) => c.unavailable).length;
  const injected = scan(t.answer).filter((f) => f.severity === 'high');
  const checks: ReplayCheck[] = [
    {
      name: 'answered',
      hard: true,
      passed: t.answer.trim().length >= 20,
      detail: t.answer.trim().length >= 20 ? 'gave an answer' : 'gave no real answer',
    },
    {
      name: 'finished',
      hard: true,
      passed: t.ended === 'answer',
      detail: t.ended === 'answer' ? `finished in ${t.rounds} step(s)` : t.ended === 'rounds' ? 'ran out of steps' : 'the model failed',
    },
    {
      name: 'tools_ok',
      hard: false,
      passed: errors * 2 <= available.length,
      detail: `${errors} of ${available.length} tool call(s) failed`,
    },
    {
      name: 'stayed_in_bounds',
      hard: false,
      passed: unavailable === 0,
      detail: unavailable === 0 ? 'used only what a replay offers' : `tried ${unavailable} tool(s) a replay does not offer`,
    },
    {
      name: 'no_refusal',
      hard: false,
      passed: !REFUSAL.test(t.answer),
      detail: REFUSAL.test(t.answer) ? 'said it could not do the task' : 'did not refuse',
    },
    {
      name: 'clean_output',
      hard: true,
      passed: injected.length === 0,
      detail: injected.length === 0 ? 'nothing injected in the answer' : `the answer carries ${injected.map((f) => f.signal).join(', ')}`,
    },
  ];
  const score = checks.filter((c) => c.passed).length / checks.length;
  const hardFailed = checks.filter((c) => c.hard && !c.passed);
  const passed = hardFailed.length === 0 && score >= PASS_SCORE;
  const failed = checks.filter((c) => !c.passed).map((c) => c.detail);
  return {
    passed,
    score,
    checks,
    verdict: passed
      ? `Passed the rules: ${checks.find((c) => c.name === 'finished')!.detail}${failed.length ? `; noted: ${failed.join('; ')}` : ''}.`
      : `Failed the rules: ${failed.join('; ')}.`,
  };
}

/** The model's reading, as it must answer: JSON with pass, score and reason. */
export interface ModelVerdict {
  pass: boolean;
  score: number;
  reason: string;
}

/** Reads the model's verdict; anything but the expected JSON is a failure, never a pass. */
export function parseModelVerdict(text: string): ModelVerdict {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return { pass: false, score: 0, reason: 'The model gave no verdict.' };
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    const score = typeof value['score'] === 'number' && Number.isFinite(value['score']) ? Math.max(0, Math.min(1, value['score'])) : 0;
    const reason = typeof value['reason'] === 'string' && value['reason'].trim() ? value['reason'].trim().slice(0, 400) : 'No reason given.';
    return { pass: value['pass'] === true, score, reason };
  } catch {
    return { pass: false, score: 0, reason: 'The model’s verdict could not be read.' };
  }
}
