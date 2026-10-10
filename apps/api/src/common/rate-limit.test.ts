import { describe, expect, it } from 'vitest';
import { WindowCounters } from './rate-limit.js';

describe('rate limit counters', () => {
  const rule = { limit: 3, windowSec: 60, per: 'email' } as const;

  function clock(start = 0) {
    let now = start;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  }

  it('allows the limit, then says how long to wait', () => {
    const time = clock();
    const counters = new WindowCounters(100, time.now);

    expect([1, 2, 3].map(() => counters.hit('a', rule))).toEqual([null, null, null]);
    expect(counters.hit('a', rule)).toBe(60);
    time.advance(45_000);
    expect(counters.hit('a', rule)).toBe(15);
  });

  it('opens a fresh window once the old one has passed', () => {
    const time = clock();
    const counters = new WindowCounters(100, time.now);
    for (let i = 0; i < 4; i++) counters.hit('a', rule);

    time.advance(60_000);
    expect(counters.hit('a', rule)).toBeNull();
  });

  it('keeps every subject to its own count', () => {
    // One account's attempts never touch another's, whatever address they share.
    const counters = new WindowCounters(100, clock().now);
    for (let i = 0; i < 4; i++) counters.hit('a', rule);

    expect(counters.hit('b', rule)).toBeNull();
  });

  it('stays within its bound when flooded with invented subjects', () => {
    const counters = new WindowCounters(1_000, clock().now);
    for (let i = 0; i < 50_000; i++) counters.hit(`invented-${i}`, rule);

    expect(counters.size).toBeLessThanOrEqual(1_000);
  });
});
