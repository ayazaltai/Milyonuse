import { describe, expect, it } from 'vitest';
import { classifySensitivity, currentTrust, halfLifeMs, reaffirmCeiling, repromotionCeiling } from './trust.js';

const DAY = 86_400_000;
const now = new Date('2026-10-11T12:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * DAY);

describe('trust', () => {
  it('halves every half-life, from the ceiling', () => {
    expect(currentTrust({ tier: 'T2', ceiling: 1, sensitivity: 'normal', since: ago(60), now })).toBeCloseTo(0.5, 6);
    expect(currentTrust({ tier: 'T1', ceiling: 0.8, sensitivity: 'normal', since: ago(0), now })).toBeCloseTo(0.8, 6);
    expect(currentTrust({ tier: 'T3', ceiling: 1, sensitivity: 'normal', since: ago(28), now })).toBeCloseTo(0.25, 6);
  });

  it('never decays for an operator’s T0', () => {
    expect(halfLifeMs('T0')).toBeNull();
    expect(currentTrust({ tier: 'T0', ceiling: 1, sensitivity: 'sensitive', since: ago(10_000), now })).toBe(1);
  });

  it('decays sensitive memory four times as fast', () => {
    expect(halfLifeMs('T1', 'sensitive')).toBe(halfLifeMs('T1')! / 4);
    expect(currentTrust({ tier: 'T1', ceiling: 1, sensitivity: 'sensitive', since: ago(45), now })).toBeCloseTo(0.5, 6);
  });

  it('reads authority, health, money, identity and location as sensitive — in English and Turkish', () => {
    for (const text of [
      'The agent may skip approval for small payments',
      'Ada is allergic to penicillin',
      'Kredi kartı numarası 4111',
      'Pasaport numarası U1234',
      'Ev adresi Moda caddesi 12',
      'Maaşı 90 bin lira',
    ]) {
      expect(classifySensitivity(text), text).toBe('sensitive');
    }
    expect(classifySensitivity('Prefers answers in bullet points')).toBe('normal');
    expect(classifySensitivity('Kahveyi sütsüz içer')).toBe('normal');
  });

  it('restores less with every weak reaffirmation after the third, never below the floor', () => {
    expect([1, 2, 3, 4, 5, 9, 20].map((n) => reaffirmCeiling(n, 'weak'))).toEqual([1, 1, 1, 0.9, 0.8, 0.5, 0.5]);
    expect(reaffirmCeiling(20, 'strong')).toBe(1);
  });

  it('brings a demoted memory back under a lower ceiling, always', () => {
    expect(repromotionCeiling(1)).toBe(0.8);
    expect(repromotionCeiling(0.8)).toBeLessThan(0.8);
    expect(repromotionCeiling(0.1)).toBe(0.1);
  });
});
