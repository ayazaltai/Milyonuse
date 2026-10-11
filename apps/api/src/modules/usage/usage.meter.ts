import { Injectable } from '@nestjs/common';
import type pg from 'pg';
import { AppLogger } from '../../common/logging/logger.js';
import { TenantScope } from '../tenancy/tenant-scope.service.js';

/** What is counted, as `area.measure` (0006, usage_daily.meter). */
export type Meter = 'agent.requests' | 'agent.tokens';

export interface UsageAttribution {
  organizationId: string;
  /** Who caused it; null for work nobody started — an automation, the clock. */
  memberId: string | null;
}

/**
 * Counts spend as it happens, in usage_daily (0006; ported from App-Milyonus
 * `modules/usage/usage.meter.ts`): one row per organization, person, UTC day
 * and meter, added to and never rewritten. The daily ceilings are read from
 * it, and a bill will be (F8).
 *
 * A count that fails is a warning, never the failure of the work it counts:
 * the model has answered either way.
 */
@Injectable()
export class UsageMeter {
  constructor(
    private readonly scope: TenantScope,
    private readonly logger: AppLogger,
  ) {}

  /** One call to the agent's model, and the tokens it read and wrote — a failed call too. */
  async agentCall(who: UsageAttribution, tokens: { input: number; output: number } | null): Promise<void> {
    await this.count(who, [
      ['agent.requests', 1],
      ['agent.tokens', tokens ? tokens.input + tokens.output : 0],
    ]);
  }

  /** What a person has counted on a meter today (UTC). */
  async today(who: UsageAttribution & { memberId: string }, meter: Meter): Promise<number> {
    return this.scope.run(who, (client) => todayOf(client, who.memberId, meter));
  }

  private async count(who: UsageAttribution, lines: [Meter, number][]): Promise<void> {
    try {
      await this.scope.run(who.organizationId, async (client) => {
        await client.query(
          `INSERT INTO usage_daily (organization_id, member_id, day, meter, events, quantity)
           SELECT $1, $2, (now() AT TIME ZONE 'UTC')::date, m.meter, 1, m.quantity
             FROM unnest($3::text[], $4::bigint[]) AS m(meter, quantity)
           ON CONFLICT ON CONSTRAINT usage_daily_once
           DO UPDATE SET events   = usage_daily.events + EXCLUDED.events,
                         quantity = usage_daily.quantity + EXCLUDED.quantity,
                         last_at  = now()`,
          [
            who.organizationId,
            who.memberId,
            lines.map(([meter]) => meter),
            lines.map(([, quantity]) => Math.max(0, Math.round(quantity))),
          ],
        );
      });
    } catch (error) {
      this.logger.warn('usage not counted', {
        meters: lines.map(([meter]) => meter),
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** A person's count on a meter today (UTC), inside a scope already open. */
export async function todayOf(client: pg.PoolClient, memberId: string, meter: Meter): Promise<number> {
  const { rows } = await client.query<{ quantity: string }>(
    `SELECT COALESCE(sum(quantity), 0) AS quantity FROM usage_daily
      WHERE member_id = $1 AND meter = $2 AND day = (now() AT TIME ZONE 'UTC')::date`,
    [memberId, meter],
  );
  return Number(rows[0]!.quantity);
}
