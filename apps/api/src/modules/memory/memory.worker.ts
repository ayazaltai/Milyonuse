import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { planConsolidation } from "@milyonuse/memory";
import type pg from "pg";
import { AppLogger } from "../../common/logging/logger.js";
import { ENV } from "../../config/config.module.js";
import type { Env } from "../../config/env.js";
import { PLATFORM_POOL } from "../../database/database.module.js";
import { TenantScope } from "../tenancy/tenant-scope.service.js";
import { MemoryService } from "./memory.service.js";
import { MemoryStore, type MemoryOwner, trustOf } from "./memory.store.js";

const TICK_MS = 60 * 60_000;
/** People a pass visits at most; the rest are next hour's. */
const PEOPLE_PER_PASS = 2000;

export interface ConsolidationReport {
  people: number;
  processed: number;
  expired: number;
  demoted: number;
  merged: number;
  flagged: number;
  embedded: number;
  ledgers: number;
  /** Organizations whose ledger did not verify — each also logged as an error. */
  broken: string[];
}

/**
 * Memory's housekeeping, while nobody waits on it (ported from Agent 5.5
 * `memory/consolidate.py`, which nothing ever scheduled — gap 9; here it is
 * the hourly pass, from the cron route or this process's own timer):
 *
 *   what waits on the pipeline is checked again;
 *   an outside claim nobody confirmed in time, and an expired memory, expire;
 *   trust is recomputed, and what fell below the floor is demoted;
 *   exact duplicates merge into the most trusted one;
 *   likely contradictions are flagged for the person;
 *   a memory kept without a vector gets one;
 *   every organization's ledger is verified, and a broken one is an error.
 *
 * Each person's memory is worked in their own scope: the platform role only
 * finds who has any.
 */
@Injectable()
export class MemoryWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly memory: MemoryService,
    private readonly store: MemoryStore,
    private readonly scope: TenantScope,
    @Inject(PLATFORM_POOL) private readonly platform: pg.Pool,
    @Inject(ENV) private readonly env: Env,
    private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.NODE_ENV === "test" || this.env.WORKER_MODE === "cron") return;
    this.timer = setInterval(() => {
      this.consolidate().catch((error: unknown) =>
        this.logger.error("memory consolidation failed", {
          err: error instanceof Error ? error.message : String(error),
        }),
      );
    }, TICK_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async consolidate(): Promise<ConsolidationReport> {
    const report: ConsolidationReport = {
      people: 0,
      processed: 0,
      expired: 0,
      demoted: 0,
      merged: 0,
      flagged: 0,
      embedded: 0,
      ledgers: 0,
      broken: [],
    };
    const { rows: people } = await this.platform.query<{
      organization_id: string;
      member_id: string;
    }>(
      `SELECT DISTINCT organization_id, member_id FROM memory_items
        WHERE member_id IS NOT NULL AND state IN ('pending', 'active', 'demoted')
        LIMIT $1`,
      [PEOPLE_PER_PASS],
    );
    for (const p of people) {
      try {
        await this.consolidateOne(
          { organizationId: p.organization_id, memberId: p.member_id },
          report,
        );
        report.people += 1;
      } catch (error) {
        this.logger.warn("memory consolidation skipped a person", {
          organizationId: p.organization_id,
          err: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const { rows: orgs } = await this.platform.query<{
      organization_id: string;
    }>(`SELECT DISTINCT organization_id FROM memory_ledger`);
    for (const o of orgs) {
      const result = await this.scope.run(o.organization_id, (client) =>
        this.store.verifyLedger(client),
      );
      report.ledgers += 1;
      if (result.brokenSeq !== null) {
        report.broken.push(o.organization_id);
        this.logger.error("memory ledger does not verify", {
          organizationId: o.organization_id,
          seq: result.brokenSeq,
        });
      }
    }
    return report;
  }

  async consolidateOne(
    owner: MemoryOwner,
    report: ConsolidationReport,
  ): Promise<void> {
    const work = await this.store.run(owner, async (client) => {
      const expired = await client.query(
        `UPDATE memory_items SET state = 'expired', state_reason = CASE WHEN state = 'pending'
                  THEN 'not independently confirmed in time' ELSE 'past its expiry' END
          WHERE state IN ('pending', 'active') AND expires_at IS NOT NULL AND expires_at < now()`,
      );
      report.expired += expired.rowCount ?? 0;
      const { rows: waiting } = await client.query<{ id: string }>(
        `SELECT id FROM memory_items WHERE state = 'pending' AND tier IN ('T1', 'T2') ORDER BY created_at LIMIT 100`,
      );
      const { rows: unembedded } = await client.query<{
        id: string;
        content: string;
      }>(
        `SELECT id, content FROM memory_items WHERE state = 'active' AND embedding IS NULL AND member_id IS NOT NULL LIMIT 100`,
      );
      return { waiting: waiting.map((w) => w.id), unembedded };
    });
    for (const id of work.waiting) {
      await this.memory.process(owner, id);
      report.processed += 1;
    }
    for (const m of work.unembedded) {
      const vector = await this.memory.embedOne(owner, m.content);
      if (!vector) continue;
      await this.store.run(owner, (client) =>
        this.store.setEmbedding(
          client,
          m.id,
          vector,
          this.memory.embeddingModel,
        ),
      );
      report.embedded += 1;
    }

    await this.store.run(owner, async (client) => {
      const now = new Date();
      const active = (await this.store.active(client, { limit: 2000, lens: "*" })).filter(
        (m) => m.member_id !== null,
      );
      // Within one scope only: an agent's own copy never expires the person's
      // memory, and the person's never folds an agent's into theirs (0011).
      const scopes = new Map<string, typeof active>();
      for (const m of active) {
        const key = `${m.scope}:${m.scope_ref ?? ""}`;
        scopes.set(key, [...(scopes.get(key) ?? []), m]);
      }
      const plans = [...scopes.values()].map((group) =>
        planConsolidation(
          group.map((m) => ({
            id: m.id,
            content: m.content,
            tier: m.tier,
            trust: trustOf(m, now),
            createdAt: m.created_at,
          })),
        ),
      );
      const plan = {
        demote: plans.flatMap((p) => p.demote),
        duplicates: plans.flatMap((p) => p.duplicates),
        contradictions: plans.flatMap((p) => p.contradictions),
      };
      for (const d of plan.demote) {
        await this.store.transition(client, d.id, "demoted", {
          reason: `trust decayed to ${d.trust.toFixed(2)} — needs reconfirmation`,
        });
        report.demoted += 1;
      }
      for (const dup of plan.duplicates) {
        await this.store.transition(client, dup.id, "expired", {
          reason: `merged into ${dup.keep}`,
        });
        report.merged += 1;
      }
      for (const [a, b] of plan.contradictions) {
        await this.store.flag(client, a, b);
        await this.store.flag(client, b, a);
        report.flagged += 1;
      }
    });
  }
}
