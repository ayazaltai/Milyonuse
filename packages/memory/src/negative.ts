import { MEMORY_POLICY } from './types.js';

/**
 * Negative memory: a rejected idea, resubmitted in other words, is the same
 * idea (ported from Agent 5.5 `memory/negative.py`). Agent 5.5 compared words
 * only, at a threshold so strict a reworded attack passed; here either signal
 * is enough — the same words (token Jaccard), or the same meaning (embedding
 * cosine) when both sides have a vector from the same embedder.
 */

const WORD = /[\p{L}\p{N}]+/gu;
// English and Turkish words that carry little of what a claim says.
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'is', 'are', 'in', 'on', 'for', 'with', 'that', 'this',
  've', 'ile', 'bir', 'bu', 'şu', 'o', 'için', 'da', 'de', 'ki', 'mi', 'her', 'gibi', 'olan',
]);

export function tokens(text: string): Set<string> {
  const words = text.normalize('NFKC').toLocaleLowerCase('tr').match(WORD) ?? [];
  return new Set(words.filter((w) => w.length > 2 && !STOP.has(w)));
}

export function jaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

/** Cosine of two vectors of one length; 0 when either is all zeros. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export interface PriorRejection {
  content: string;
  embedding?: readonly number[] | null;
  /** The embedder the vector came from; vectors of different embedders are never compared. */
  embeddingModel?: string | null;
}

export interface RephraseMatch {
  rephrase: boolean;
  matched: string | null;
  /** The strongest signal found, and which. */
  score: number;
  by: 'jaccard' | 'cosine' | null;
}

export function isRephrase(
  candidate: { content: string; embedding?: readonly number[] | null; embeddingModel?: string | null },
  priors: readonly PriorRejection[],
): RephraseMatch {
  let best: RephraseMatch = { rephrase: false, matched: null, score: 0, by: null };
  for (const prior of priors) {
    const words = jaccard(candidate.content, prior.content);
    if (words >= MEMORY_POLICY.rephraseJaccard) return { rephrase: true, matched: prior.content, score: words, by: 'jaccard' };
    if (words > best.score) best = { rephrase: false, matched: prior.content, score: words, by: 'jaccard' };
    if (
      candidate.embedding &&
      prior.embedding &&
      candidate.embeddingModel &&
      candidate.embeddingModel === prior.embeddingModel
    ) {
      const meaning = cosine(candidate.embedding, prior.embedding);
      if (meaning >= MEMORY_POLICY.rephraseCosine) {
        return { rephrase: true, matched: prior.content, score: meaning, by: 'cosine' };
      }
      if (meaning > best.score) best = { rephrase: false, matched: prior.content, score: meaning, by: 'cosine' };
    }
  }
  return best;
}
