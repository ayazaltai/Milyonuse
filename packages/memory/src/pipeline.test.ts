import { describe, expect, it } from 'vitest';
import { decide } from './pipeline.js';
import type { Verdict } from './verifier.js';

const passed: Verdict = { approved: true, reason: 'ok', isInstruction: false, sourceCompetent: true, contradicts: false };
const refused: Verdict = { ...passed, approved: false, reason: 'scanner flagged: imperative' };

describe('the tier rules', () => {
  it('promote the person’s words and the agent’s observation once checked', () => {
    expect(decide({ tier: 'T1', verdict: passed, rephraseOf: null, confirmations: 0 }).action).toBe('promote');
    expect(decide({ tier: 'T2', verdict: passed, rephraseOf: null, confirmations: 0 }).action).toBe('promote');
  });

  it('hold an outside claim until two independent confirmations', () => {
    expect(decide({ tier: 'T3', verdict: passed, rephraseOf: null, confirmations: 1 })).toMatchObject({
      action: 'await_confirmation',
      expiresInDays: 14,
    });
    expect(decide({ tier: 'T3', verdict: passed, rephraseOf: null, confirmations: 2 }).action).toBe('promote');
  });

  it('leave an unknown claim to the person', () => {
    expect(decide({ tier: 'T4', verdict: passed, rephraseOf: null, confirmations: 9 }).action).toBe('await_approval');
  });

  it('reject a refusal and remember it; reject a rephrase without remembering it twice', () => {
    expect(decide({ tier: 'T2', verdict: refused, rephraseOf: null, confirmations: 0 })).toMatchObject({ action: 'reject', remember: true });
    expect(decide({ tier: 'T1', verdict: passed, rephraseOf: 'skip approval', confirmations: 0 })).toMatchObject({
      action: 'reject',
      remember: false,
    });
  });
});
