import { Global, Module } from '@nestjs/common';
import { AppLogger } from '../../common/logging/logger.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { AGENT_MODEL, type AgentModel } from '../agent/agent-model.port.js';
import { DevelopmentAgentModel } from '../agent/development.model.js';
import { OpenRouterAgentModel } from '../agent/openrouter.model.js';
import { UnconfiguredAgentModel } from '../agent/unconfigured.model.js';

/**
 * Where model answers come from on this deployment (D-03): the model router
 * when there is a key; without one, a development stand-in that says what it
 * is — or, in production, nothing, and the agent says it is not set up. The
 * stand-in pattern-matches and refuses production itself as well.
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
 * The one model boundary, shared: the agent's turns and the memory verifier
 * ask the same router, metered the same way.
 */
@Global()
@Module({
  providers: [{ provide: AGENT_MODEL, inject: [ENV, AppLogger], useFactory: agentModelFor }],
  exports: [AGENT_MODEL],
})
export class ModelModule {}
