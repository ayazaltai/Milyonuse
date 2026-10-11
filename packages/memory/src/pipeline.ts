import { MEMORY_POLICY, type TrustTier } from './types.js';
import type { Verdict } from './verifier.js';

/**
 * What happens to a candidate once it has been checked — the tier rules of
 * the pipeline (ported from Agent 5.5 `memory/pipeline.py` process_one),
 * separated from storage so they are one pure function the store applies:
 *
 *   T1  the person's own words   promoted if the rules pass
 *   T2  the agent's observation  promoted if the verifier passes
 *   T3  an outside source        waits for two independent confirmations
 *   T4  a subagent, unknown      waits for the person
 *
 * A rephrase of something rejected, or a refusal, rejects it — and a refusal
 * is remembered, so the same idea in other words is caught next time.
 */
export type Decision =
  | { action: 'reject'; reason: string; remember: boolean }
  | { action: 'promote'; reason: string }
  | { action: 'await_confirmation'; reason: string; expiresInDays: number }
  | { action: 'await_approval'; reason: string };

export function decide(input: {
  tier: TrustTier;
  verdict: Verdict;
  rephraseOf: string | null;
  /** Independent confirmations already recorded (memory_confirmations). */
  confirmations: number;
}): Decision {
  if (input.rephraseOf !== null) {
    return { action: 'reject', reason: `rephrase of a rejected idea: “${input.rephraseOf.slice(0, 80)}”`, remember: false };
  }
  if (!input.verdict.approved) return { action: 'reject', reason: input.verdict.reason, remember: true };
  switch (input.tier) {
    case 'T1':
    case 'T2':
      return { action: 'promote', reason: input.verdict.reason };
    case 'T3':
      return input.confirmations >= MEMORY_POLICY.t3Confirmations
        ? { action: 'promote', reason: `${input.verdict.reason}; independently confirmed` }
        : {
            action: 'await_confirmation',
            reason: `needs ${MEMORY_POLICY.t3Confirmations - input.confirmations} more independent confirmation(s)`,
            expiresInDays: MEMORY_POLICY.t3TtlDays,
          };
    default:
      return { action: 'await_approval', reason: 'waits for the person to approve it' };
  }
}
