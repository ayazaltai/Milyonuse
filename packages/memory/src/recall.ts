/**
 * Recall ranking (ported from Agent 5.5 `memory/semantic.py`). Similarity
 * alone would let a close but barely trusted match outrank a trusted one —
 * the shape a poisoning attack takes. So a candidate's score is its
 * similarity times its current trust, and recall reads more candidates than
 * it returns, so a trusted memory a little further away is still found.
 */

export interface RecallCandidate<T> {
  item: T;
  /** Cosine similarity to the query, 0–1. */
  similarity: number;
  /** Current trust, 0–1. */
  trust: number;
}

export interface Recalled<T> {
  item: T;
  score: number;
  similarity: number;
}

/** How many candidates to read from the index for `k` answers. */
export function overFetch(k: number): number {
  return Math.min(200, Math.max(20, k * 4));
}

export function rankRecall<T>(candidates: readonly RecallCandidate<T>[], k: number, minSimilarity = 0.05): Recalled<T>[] {
  return candidates
    .filter((c) => c.similarity >= minSimilarity)
    .map((c) => ({ item: c.item, similarity: c.similarity, score: c.similarity * c.trust }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
