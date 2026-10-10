import { describe, expect, it } from 'vitest';
import { judgeCadences, type HeartbeatRow } from './health.service.js';

/** A heartbeat that last finished `age` seconds ago and first finished `since` seconds ago. */
function beat(cadence: string, age: number, since = age): HeartbeatRow {
  const now = Date.parse('2026-09-26T12:16:00Z');
  return {
    cadence,
    finished_at: new Date(now - age * 1000),
    ok: true,
    age,
    first_finished_at: new Date(now - since * 1000),
  };
}

describe('which scheduled passes are overdue', () => {
  it('a pass that has not come round yet on a new database is not', () => {
    // A deployment minutes old: the minute pass calling since, the
    // quarter-hour and hour passes not yet due.
    const cadences = judgeCadences([beat('minute', 24, 5 * 60)]);
    expect(cadences['minute']?.stale).toBe(false);
    expect(cadences['quarter-hour']).toEqual({
      finishedAt: null,
      ageSeconds: null,
      ok: null,
      stale: false,
    });
    expect(cadences['hour']?.stale).toBe(false);
  });

  it('a pass that never finished though the scheduler has called for longer than it may be late is', () => {
    const cadences = judgeCadences([beat('minute', 30, 50 * 60)]);
    expect(cadences['quarter-hour']?.stale).toBe(true); // 45 min allowed
    expect(cadences['hour']?.stale).toBe(false); // 150 min allowed
  });

  it('counts from the first finish of any pass, not the latest', () => {
    const cadences = judgeCadences([beat('minute', 20, 60), beat('quarter-hour', 600, 3 * 3600)]);
    expect(cadences['hour']?.stale).toBe(true);
  });

  it('nothing finished at all is overdue', () => {
    const cadences = judgeCadences([]);
    expect(Object.values(cadences).map((c) => c.stale)).toEqual([true, true, true]);
  });

  it('a pass that has finished is judged by its last finish alone', () => {
    const cadences = judgeCadences([beat('minute', 11 * 60, 11 * 60)]);
    expect(cadences['minute']?.stale).toBe(true);
  });
});
