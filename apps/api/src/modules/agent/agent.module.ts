import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module.js';
import { ActionController } from './actions/action.controller.js';
import { ActionService } from './actions/action.service.js';
import { ActionStore } from './actions/action.store.js';
import { AgentAttachmentService } from './agent-attachment.service.js';
import { AgentController } from './agent.controller.js';
import { AgentExportService } from './agent.export.js';
import { AgentService } from './agent.service.js';
import { AgentStore } from './agent.store.js';
import { AgentToolbox } from './agent.toolbox.js';

/**
 * The agent core — Phase 1 (docs/phases/F1-agent-core.md): conversations,
 * a streamed turn loop over tools, attachments, summaries, ratings and
 * export — from Phase 2, verified memory through its tools and prompt; from
 * Phase 3, actions: the RiskEngine, proposals, confirmation and undo.
 * Its model comes from ModelModule.
 */
@Module({
  imports: [MemoryModule],
  controllers: [AgentController, ActionController],
  providers: [AgentStore, AgentToolbox, AgentService, AgentAttachmentService, AgentExportService, ActionStore, ActionService],
  exports: [AgentService, AgentStore, AgentToolbox, ActionService],
})
export class AgentModule {}
