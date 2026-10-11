import { jaccard } from './negative.js';
import { MEMORY_POLICY, type TrustTier } from './types.js';

/**
 * The night's housekeeping, decided (ported from Agent 5.5
 * `memory/consolidate.py`): which active memories have decayed below the
 * floor and are demoted, which are exact duplicates of a more trusted one,
 * and which pairs look like a contradiction for the person to settle. The
 * store applies the plan; every change it makes is ledgered by the database.
 */

export interface ConsolidationItem {
  id: string;
  content: string;
  tier: TrustTier;
  trust: number;
  createdAt: Date;
}

export interface ConsolidationPlan {
  demote: { id: string; trust: number }[];
  duplicates: { id: string; keep: string }[];
  contradictions: [string, string][];
}

const RANK: Record<TrustTier, number> = { T0: 0, T1: 1, T2: 2, T3: 3, T4: 4 };
const NEGATION = [' not ', " n't", 'never', ' no ', ' değil', ' yok', 'asla', 'hiç', 'sevmez', 'istemez'];

function negated(text: string): boolean {
  const low = ` ${text.toLocaleLowerCase('tr')} `;
  return NEGATION.some((w) => low.includes(w));
}

export function planConsolidation(items: readonly ConsolidationItem[], contradictionThreshold = 0.6): ConsolidationPlan {
  const demote = items
    .filter((m) => m.tier !== 'T0' && m.trust < MEMORY_POLICY.demoteFloor)
    .map((m) => ({ id: m.id, trust: m.trust }));
  const gone = new Set(demote.map((d) => d.id));

  const duplicates: ConsolidationPlan['duplicates'] = [];
  const byContent = new Map<string, ConsolidationItem[]>();
  for (const m of items) {
    if (gone.has(m.id)) continue;
    const key = m.content.trim().toLocaleLowerCase('tr');
    byContent.set(key, [...(byContent.get(key) ?? []), m]);
  }
  for (const group of byContent.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => RANK[a.tier] - RANK[b.tier] || a.createdAt.getTime() - b.createdAt.getTime());
    for (const dup of group.slice(1)) {
      duplicates.push({ id: dup.id, keep: group[0]!.id });
      gone.add(dup.id);
    }
  }

  // Close in words, opposite in polarity: likely a contradiction. Surfaced for
  // the person, never acted on — polarity is hard to read from words alone.
  const remaining = items.filter((m) => !gone.has(m.id));
  const contradictions: [string, string][] = [];
  for (let i = 0; i < remaining.length; i += 1) {
    for (let j = i + 1; j < remaining.length; j += 1) {
      const a = remaining[i]!;
      const b = remaining[j]!;
      if (negated(a.content) !== negated(b.content) && jaccard(a.content, b.content) >= contradictionThreshold) {
        contradictions.push([a.id, b.id]);
      }
    }
  }
  return { demote, duplicates, contradictions };
}
