import { Module } from '@nestjs/common';
import { AppLogger } from '../../common/logging/logger.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { AGENT_MODEL, type AgentModel } from './agent-model.port.js';
import { AgentAttachmentService } from './agent-attachment.service.js';
import { AgentController } from './agent.controller.js';
import { AgentExportService } from './agent.export.js';
import { AgentService } from './agent.service.js';
import { AgentStore } from './agent.store.js';
import { AgentToolbox } from './agent.toolbox.js';
import { DevelopmentAgentModel } from './development.model.js';
import { OpenRouterAgentModel } from './openrouter.model.js';
import { UnconfiguredAgentModel } from './unconfigured.model.js';

/**
 * Where the agent's answers come from on this deployment (D-03): the model
 * router when there is a key; without one, a development stand-in that says
 * what it is — or, in production, nothing, and the agent says it is not set
 * up. The stand-in pattern-matches and refuses production itself as well.
 */
export function agentModelFor(env: Env, logger: AppLogger): AgentModel {
  if (env.OPENROUTER_API_KEY) {
    return new OpenRouterAgentModel(
      env.OPENROUTER_API_KEY,
      { appUrl: env.APP_BASE_URL, zeroRetention: env.AGENT_ZERO_RETENTION },
      logger,
    );
  }
  return env.NODE_ENV === 'production' ? new UnconfiguredAgentModel() : new DevelopmentAgentModel(env.NODE_ENV);
}

/**
 * The agent core — Phase 1 (docs/phases/F1-agent-core.md): conversations,
 * a streamed turn loop over tools, attachments, summaries, ratings and
 * export. Memory (F2), connections and proposals (F3), agents and skills
 * (F4) build on it.
 */
@Module({
  controllers: [AgentController],
  providers: [
    { provide: AGENT_MODEL, inject: [ENV, AppLogger], useFactory: agentModelFor },
    AgentStore,
    AgentToolbox,
    AgentService,
    AgentAttachmentService,
    AgentExportService,
  ],
  exports: [AgentService, AgentStore, AgentToolbox],
})
export class AgentModule {}
