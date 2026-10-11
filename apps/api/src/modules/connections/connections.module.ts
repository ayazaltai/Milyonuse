import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { ToolsModule } from '../tools/tools.module.js';
import { ConnectionsController } from './connections.controller.js';
import { ConnectionsService } from './connections.service.js';

/**
 * Connected apps (F3 §3): MCP servers and Google's apps, authorized by the
 * person, offered to the agent as their own tools.
 */
@Module({
  imports: [AgentModule, ToolsModule],
  controllers: [ConnectionsController],
  providers: [ConnectionsService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
