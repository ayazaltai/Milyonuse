import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module.js';
import { AgentAttachmentService } from './agent-attachment.service.js';
import { AgentController } from './agent.controller.js';
import { AgentExportService } from './agent.export.js';
import { AgentService } from './agent.service.js';
import { AgentStore } from './agent.store.js';
import { AgentToolbox } from './agent.toolbox.js';

/**
 * The agent core — Phase 1 (docs/phases/F1-agent-core.md): conversations,
 * a streamed turn loop over tools, attachments, summaries, ratings and
 * export — and, from Phase 2, verified memory through its tools and prompt.
 * Its model comes from ModelModule.
 */
@Module({
  imports: [MemoryModule],
  controllers: [AgentController],
  providers: [AgentStore, AgentToolbox, AgentService, AgentAttachmentService, AgentExportService],
  exports: [AgentService, AgentStore, AgentToolbox],
})
export class AgentModule {}
