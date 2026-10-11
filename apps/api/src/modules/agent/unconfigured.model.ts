import { ErrorCode } from '@milyonuse/contracts';
import { AppError } from '../../common/app-error.js';
import type { AgentModel } from './agent-model.port.js';

/**
 * Production without OPENROUTER_API_KEY.
 *
 * The API starts regardless — the agent is a surface added to the product,
 * not part of what everything else needs — and every call to it says plainly
 * that it is not set up, rather than pretending to think.
 */
export class UnconfiguredAgentModel implements AgentModel {
  readonly name = 'unconfigured' as const;

  complete(): Promise<never> {
    return Promise.reject(
      new AppError(
        ErrorCode.AGENT_NOT_CONFIGURED,
        'The agent is not set up on this deployment yet.',
      ),
    );
  }
}
