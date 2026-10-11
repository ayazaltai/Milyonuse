import { describe, expect, it } from 'vitest';
import { planConsolidation, type ConsolidationItem } from './consolidate.js';
import { activateMessage, stageMessage } from './t0.js';
import { candidateObservations } from './user-model.js';

const item = (id: string, content: string, trust = 0.9, tier: ConsolidationItem['tier'] = 'T2'): ConsolidationItem => ({
  id,
  content,
  tier,
  trust,
  createdAt: new Date(Date.UTC(2026, 9, Number(id.replace(/\D/g, '') || 1))),
});

describe('the night’s plan', () => {
  it('demotes what decayed below the floor, never an operator’s policy', () => {
    const plan = planConsolidation([item('a1', 'x', 0.2), item('b2', 'y', 0.5), item('c3', 'z', 0.1, 'T0')]);
    expect(plan.demote).toEqual([{ id: 'a1', trust: 0.2 }]);
  });

  it('keeps the most trusted of exact duplicates', () => {
    const plan = planConsolidation([item('a1', 'Lives in Lisbon', 0.9, 'T2'), item('b2', 'lives in lisbon ', 0.9, 'T1')]);
    expect(plan.duplicates).toEqual([{ id: 'a1', keep: 'b2' }]);
  });

  it('flags a likely contradiction for the person, and acts on nothing', () => {
    const plan = planConsolidation([item('a1', 'Ada drinks coffee with milk'), item('b2', 'Ada never drinks coffee with milk')]);
    expect(plan.contradictions).toEqual([['a1', 'b2']]);
    expect(plan.demote).toEqual([]);
  });
});

describe('what of the person’s words is offered to memory', () => {
  it('picks durable statements about themselves, in English and Turkish', () => {
    expect(
      candidateObservations('Hi there. I prefer short answers. My timezone is Europe/Istanbul. Can you help me?'),
    ).toEqual(['I prefer short answers.', 'My timezone is Europe/Istanbul.']);
    expect(candidateObservations('Ben genelde sabahları çalışırım. Kahveyi sütsüz severim.')).toEqual([
      'Ben genelde sabahları çalışırım.',
      'Kahveyi sütsüz severim.',
    ]);
  });

  it('offers no questions, no repeats, and at most five', () => {
    expect(candidateObservations('Do I prefer tea?')).toEqual([]);
    expect(candidateObservations('I like tea. I like tea.')).toEqual(['I like tea.']);
    expect(candidateObservations(Array.from({ length: 8 }, (_, i) => `I like thing ${i}.`).join(' '))).toHaveLength(5);
  });
});

describe('operator messages', () => {
  it('bind a T0 to one organization, and its activation to one claim', () => {
    expect(stageMessage('org-a', 'x')).not.toBe(stageMessage('org-b', 'x'));
    expect(activateMessage('item', 'hash')).toBe('milyonuse:t0:activate:item:hash');
  });
});
