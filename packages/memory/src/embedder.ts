import { tokens } from './negative.js';

/**
 * Turning memory into vectors, for recall and for catching a reworded idea.
 *
 * The port takes many texts at once; an implementation names itself in
 * `model`, which is stored beside every vector, so vectors of different
 * embedders are never compared and a change of embedder is a re-index, not a
 * silent loss of recall.
 */
export interface Embedder {
  /** Stored with every vector it makes. */
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** The width of 0007's vector columns. */
export const EMBEDDING_DIMENSIONS = 1536;

/** FNV-1a, 32 bits: the same number for the same text, in every process, forever. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A deterministic, dependency-free embedder: each word is hashed to one of the
 * dimensions with a sign, and the sum is normalised. It measures shared words,
 * not meaning — honestly named, and used where no embedding model is
 * configured.
 *
 * Agent 5.5's version hashed with Python's `hash()`, which is salted per
 * process: two processes put the same word in different places, and recall
 * silently found nothing after a restart. FNV-1a is the same everywhere.
 */
export class HashingEmbedder implements Embedder {
  readonly model = `fnv1a-${EMBEDDING_DIMENSIONS}`;
  readonly dimensions = EMBEDDING_DIMENSIONS;

  embed(texts: readonly string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.one(text)));
  }

  private one(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    for (const word of tokens(text)) {
      const hash = fnv1a(word);
      vector[hash % this.dimensions]! += (hash >>> 31) & 1 ? -1 : 1;
    }
    const norm = Math.sqrt(vector.reduce((n, x) => n + x * x, 0));
    return norm === 0 ? vector : vector.map((x) => x / norm);
  }
}
