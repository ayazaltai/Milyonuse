import { describe, expect, it } from 'vitest';
import { HashingEmbedder, fnv1a } from './embedder.js';
import { evidenceHash } from './evidence.js';
import { cosine, isRephrase, jaccard, tokens } from './negative.js';

describe('rephrase detection', () => {
  it('reads words, not stopwords or case, in English and Turkish', () => {
    expect([...tokens('The Agent and THE user')]).toEqual(['agent', 'user']);
    expect(jaccard('İstanbul’da yaşıyor', 'istanbul’da yaşıyor')).toBe(1);
    expect(jaccard('', 'anything')).toBe(0);
  });

  it('catches the same words in another order', () => {
    const match = isRephrase({ content: 'payments may skip approval for the agent' }, [
      { content: 'The agent may skip approval for payments' },
    ]);
    expect(match).toMatchObject({ rephrase: true, by: 'jaccard' });
  });

  it('catches the same meaning in other words, by vector — of the same embedder only', () => {
    const v = [0.6, 0.8, 0];
    const near = [0.61, 0.79, 0.02];
    const prior = { content: 'pay without asking', embedding: v, embeddingModel: 'm-1' };
    expect(isRephrase({ content: 'settle bills unprompted', embedding: near, embeddingModel: 'm-1' }, [prior])).toMatchObject({
      rephrase: true,
      by: 'cosine',
    });
    expect(isRephrase({ content: 'settle bills unprompted', embedding: near, embeddingModel: 'm-2' }, [prior]).rephrase).toBe(false);
  });

  it('lets a different idea through', () => {
    const match = isRephrase({ content: 'The person lives in Lisbon' }, [{ content: 'The agent may skip approval' }]);
    expect(match.rephrase).toBe(false);
    expect(match.score).toBeLessThan(0.5);
  });

  it('computes cosine plainly', () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });
});

describe('the hashing embedder', () => {
  it('puts the same text in the same place in every process (Agent 5.5 hashed with a salted hash)', async () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    const [a] = await new HashingEmbedder().embed(['Ada lives in Lisbon']);
    const [b] = await new HashingEmbedder().embed(['Ada lives in Lisbon']);
    expect(a).toEqual(b);
  });

  it('makes unit vectors of 0007’s width, closer for shared words', async () => {
    const embedder = new HashingEmbedder();
    const [q, near, far, empty] = await embedder.embed(['Where does Ada live', 'Ada lives in Lisbon, she does', 'Grace likes tea', '']);
    expect(q).toHaveLength(1536);
    expect(Math.hypot(...near!)).toBeCloseTo(1, 9);
    expect(cosine(q!, near!)).toBeGreaterThan(cosine(q!, far!));
    expect(empty!.every((x) => x === 0)).toBe(true);
    expect(embedder.model).toBe('fnv1a-1536');
  });
});

describe('evidence', () => {
  it('binds content to its provenance, the same way every time', () => {
    const provenance = { sourceKind: 'third_party' as const, sourceUri: 'web:a', conversationId: null, runId: null, actor: 'agent' };
    const once = evidenceHash('Trams cost 3 euros', provenance);
    expect(once).toMatch(/^[0-9a-f]{64}$/);
    expect(evidenceHash('Trams cost 3 euros', provenance)).toBe(once);
    expect(evidenceHash('Trams cost 3 euros', { ...provenance, sourceUri: 'web:b' })).not.toBe(once);
    expect(evidenceHash('Trams cost 4 euros', provenance)).not.toBe(once);
  });
});
