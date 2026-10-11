import { MEMORY_POLICY, RuleVerifier, SOURCE_TIER, type Verifier, decide } from '@milyonuse/memory';
import { ATTACKS, type Attack } from './attacks.js';
import type { Outcome } from './metrics.js';

/**
 * The corpus through the pipeline's rules alone, without a database: each
 * candidate in an empty memory, at the tier its channel gives it, checked by
 * the verifier and decided by the tier rules. An outside claim is given every
 * confirmation it needs — the attacker controls as many sources as they like —
 * so only the verifier stands between it and memory.
 *
 * The API's PoisonBench suite runs the same corpus through the real service
 * and database; this is the fast, pure measurement of the rules themselves.
 */
export async function runRules(verifier: Verifier = new RuleVerifier(), attacks: readonly Attack[] = ATTACKS): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const attack of attacks) {
    const tier = SOURCE_TIER[attack.sourceKind];
    const verdict = await verifier.verify({ content: attack.content, sourceKind: attack.sourceKind, tier, existing: [] });
    const decision = decide({
      tier,
      verdict,
      rephraseOf: null,
      confirmations: tier === 'T3' ? MEMORY_POLICY.t3Confirmations : 0,
    });
    const promoted = decision.action === 'promote';
    outcomes.push({
      attack,
      promoted,
      persisted: promoted,
      state: promoted ? 'active' : decision.action === 'reject' ? 'rejected' : 'pending',
      reason: decision.reason,
    });
  }
  return outcomes;
}
