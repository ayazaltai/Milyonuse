import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { StudioModule } from '../studio/studio.module.js';
import { RunEngine } from './run-engine.js';
import { RunHooks } from './run-hooks.js';
import { RunsController, TeamsController } from './teams.controller.js';
import { TeamsService } from './teams.service.js';
import { TeamsStore } from './teams.store.js';

/**
 * Agent teams — Phase 5 (docs/phases/F5-agent-teams.md): teams of a person's
 * agents, and runs the engine advances in the durable queue.
 */
@Module({
  imports: [AgentModule, MemoryModule, StudioModule],
  controllers: [TeamsController, RunsController],
  providers: [TeamsStore, TeamsService, RunEngine, RunHooks],
  exports: [TeamsService, TeamsStore, RunEngine, RunHooks],
})
export class TeamsModule {}
