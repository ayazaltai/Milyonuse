import { describe, expect, it } from 'vitest';
import { deriveProvenance } from './taint.js';

describe('where a memory came from, decided by the server', () => {
  it('is the agent’s own observation in a clean turn', () => {
    expect(deriveProvenance({ origin: 'agent', runSources: [] })).toEqual({
      sourceKind: 'agent_observed',
      tier: 'T2',
      sourceUri: null,
      derivedFrom: [],
    });
  });

  it('is as untrusted as the least trusted thing the turn read, and derived from all of it', () => {
    const derived = deriveProvenance({
      origin: 'agent',
      runSources: [
        { kind: 'third_party', uri: 'attachment:a' },
        { kind: 'subagent', uri: 'agent:helper' },
        { kind: 'third_party', uri: 'attachment:a' },
      ],
    });
    expect(derived).toEqual({ sourceKind: 'subagent', tier: 'T4', sourceUri: 'attachment:a', derivedFrom: ['attachment:a', 'agent:helper'] });
  });

  it('never lets the model raise trust — it may only lower it (T1 laundering)', () => {
    // Agent 5.5 let the model say "user-direct" and promoted its words at T1.
    expect(deriveProvenance({ origin: 'agent', runSources: [], lowerTier: 'T1' }).tier).toBe('T2');
    expect(deriveProvenance({ origin: 'agent', runSources: [{ kind: 'third_party', uri: 'web:x' }], lowerTier: 'T1' }).tier).toBe('T3');
    expect(deriveProvenance({ origin: 'agent', runSources: [], lowerTier: 'T4' }).tier).toBe('T4');
  });

  it('keeps the person’s own words theirs', () => {
    expect(deriveProvenance({ origin: 'person', runSources: [{ kind: 'third_party', uri: 'web:x' }] })).toMatchObject({
      sourceKind: 'user_direct',
      tier: 'T1',
      derivedFrom: [],
    });
  });
});
