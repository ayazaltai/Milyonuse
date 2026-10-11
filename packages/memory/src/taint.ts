import { SOURCE_TIER, type SourceKind, type TrustTier, lessTrusted, tierRank } from './types.js';

/**
 * Where a memory came from, decided by the server from what the turn did —
 * never by the model (D-12; Agent 5.5's "T1 laundering" gap).
 *
 * Agent 5.5 let the model say `source_kind: "user-direct"` and its own words
 * became the person's, at the highest trust a claim can have. Here the model
 * says nothing about the source: a memory the agent proposes is its own
 * observation (T2) in a clean turn, and as untrusted as the least trusted
 * thing the turn read when it read anything from outside — a document, a web
 * page, a mail, another agent. Those sources become its derivations, so
 * revoking any of them takes the memory with it. The model may only ask for
 * *less* trust, never more.
 */

export interface RunSource {
  kind: Extract<SourceKind, 'third_party' | 'subagent' | 'unknown'>;
  uri: string;
}

export interface DerivedProvenance {
  sourceKind: SourceKind;
  tier: TrustTier;
  /** The one source a tainted memory is attributed to: the first the turn read. */
  sourceUri: string | null;
  /** Every outside source the turn read — the memory's derivations. */
  derivedFrom: string[];
}

export function deriveProvenance(input: {
  /** Who is proposing: the agent (a tool call), or the person's own words (reflection, the inspector). */
  origin: 'agent' | 'person';
  runSources: readonly RunSource[];
  /** The model asked for less trust than the turn would give. */
  lowerTier?: TrustTier | undefined;
}): DerivedProvenance {
  // The person's own words are theirs: they come before anything the turn read.
  if (input.origin === 'person') {
    return {
      sourceKind: 'user_direct',
      tier: input.lowerTier ? lessTrusted('T1', input.lowerTier) : 'T1',
      sourceUri: null,
      derivedFrom: [],
    };
  }
  const uris = [...new Set(input.runSources.map((s) => s.uri))];
  let sourceKind: SourceKind = 'agent_observed';
  for (const s of input.runSources) {
    if (sourceKind === 'agent_observed' || tierRank(SOURCE_TIER[s.kind]) > tierRank(SOURCE_TIER[sourceKind])) {
      sourceKind = s.kind;
    }
  }
  const base = SOURCE_TIER[sourceKind];
  return {
    sourceKind,
    tier: input.lowerTier ? lessTrusted(base, input.lowerTier) : base,
    sourceUri: uris[0] ?? null,
    derivedFrom: uris,
  };
}
