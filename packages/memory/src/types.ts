/**
 * The verified-memory vocabulary (ported from Agent 5.5 `memory/model.py`,
 * Apache-2.0). The names match 0007_memory's enums one for one.
 */

/** How much a memory is trusted, by where it came from. A lower number is more trusted. */
export const TRUST_TIERS = ['T0', 'T1', 'T2', 'T3', 'T4'] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

/** Where a memory came from — what decides which tier it may hold. */
export const SOURCE_KINDS = ['operator', 'user_direct', 'agent_observed', 'third_party', 'subagent', 'unknown'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const MEMORY_STATES = ['pending', 'active', 'demoted', 'rejected', 'revoked', 'expired', 't0_staged'] as const;
export type MemoryState = (typeof MEMORY_STATES)[number];

export const MEMORY_SCOPES = ['user', 'agent', 'team'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export type Sensitivity = 'normal' | 'sensitive';

/** The sealed record of where a memory came from. */
export interface Provenance {
  sourceKind: SourceKind;
  sourceUri: string | null;
  conversationId: string | null;
  runId: string | null;
  /** Who asserted it: `member:<id>`, `agent`, `operator`, a tool's name. */
  actor: string;
}

/** The most trusted tier each source may claim (0007, app.memory_tier_floor). */
export const SOURCE_TIER: Record<SourceKind, TrustTier> = {
  operator: 'T0',
  user_direct: 'T1',
  agent_observed: 'T2',
  third_party: 'T3',
  subagent: 'T4',
  unknown: 'T4',
};

export function tierRank(tier: TrustTier): number {
  return TRUST_TIERS.indexOf(tier);
}

/** The less trusted of two tiers. */
export function lessTrusted(a: TrustTier, b: TrustTier): TrustTier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

/**
 * The knobs of the memory pipeline, at the safe end of each range (Agent 5.5
 * `config/schema.py` MemoryConfig). Those the database also enforces — two
 * confirmations, the five-minute review — are the same numbers there.
 */
export const MEMORY_POLICY = {
  /** Independent confirmations a third-party claim needs (0007). */
  t3Confirmations: 2,
  /** Days an unconfirmed third-party claim waits before it expires. */
  t3TtlDays: 14,
  /** Half-life of trust, in days, per tier; T0 never decays. */
  halfLifeDays: { T0: null, T1: 180, T2: 60, T3: 14, T4: 14 } as Record<TrustTier, number | null>,
  /** Sensitive memory decays this much faster (half-life × factor). */
  sensitiveFactor: 0.25,
  /** Below this trust an active memory is demoted. */
  demoteFloor: 0.25,
  /** Seconds between staging an operator claim and activating it (0007). */
  t0ReviewSeconds: 300,
  /** A memory is reaffirmed at most once in this many hours. */
  reaffirmIntervalHours: 24,
  /** A weak (the person's) reaffirmation never restores less than this ceiling. */
  weakReaffirmFloor: 0.5,
  /** A rejected idea in other words: token Jaccard at least this… */
  rephraseJaccard: 0.86,
  /** …or embedding cosine at least this. */
  rephraseCosine: 0.92,
} as const;
