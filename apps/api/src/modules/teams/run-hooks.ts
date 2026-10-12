import { Injectable } from '@nestjs/common';
import type { Principal } from '@milyonuse/contracts';
import { AppLogger } from '../../common/logging/logger.js';
import type { EngineTool } from './team-turn.js';
import type { RunRow } from './teams.store.js';

/** What another module adds to a run: tools its turns may call, and what happens when it ends. */
export interface RunHook {
  /** Engine tools for the run's turns — an automation's goal_reached, say. */
  tools?(principal: Principal, run: RunRow): Promise<EngineTool[]>;
  /** The run completed or failed: an automation records its outcome and starts what follows it. */
  ended?(principal: Principal, run: RunRow, outcome: 'completed' | 'failed'): Promise<void>;
}

/**
 * The run engine's extension points (F6): automations sit on top of runs
 * without the engine knowing them. A hook that fails is logged; it never fails
 * the run it was told about.
 */
@Injectable()
export class RunHooks {
  private readonly hooks: RunHook[] = [];

  constructor(private readonly logger: AppLogger) {}

  register(hook: RunHook): void {
    this.hooks.push(hook);
  }

  async tools(principal: Principal, run: RunRow): Promise<EngineTool[]> {
    const out: EngineTool[] = [];
    for (const hook of this.hooks) if (hook.tools) out.push(...(await hook.tools(principal, run)));
    return out;
  }

  async ended(principal: Principal, run: RunRow, outcome: 'completed' | 'failed'): Promise<void> {
    for (const hook of this.hooks) {
      try {
        await hook.ended?.(principal, run, outcome);
      } catch (error) {
        this.logger.error('run hook failed', { runId: run.id, err: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}
