import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/app-error.js';
import { AppLogger } from '../../common/logging/logger.js';
import type { AgentToolSpec } from './agent-model.port.js';
import { AgentStore } from './agent.store.js';
import { attachmentTools } from './tools/attachment.tools.js';
import { presentTool } from './tools/present.tool.js';
import { timeTool } from './tools/time.tool.js';
import { type AgentTool, type ToolContext, ToolError, type ToolOutcome, describeIssues, specOf } from './tools/tool.js';

/**
 * Every tool the agent has, in one place: their schemas as the model sees
 * them, and running one — its arguments parsed and validated here, never
 * trusted as the model wrote them (ported from App-Milyonus
 * `modules/agent/agent.toolbox.ts`).
 *
 * A refusal the model can act on — an invented id, an argument out of range —
 * is answered to it as `{ "error": … }`, and the model corrects itself or
 * asks the person. Only a fault of the system is logged as one.
 */
@Injectable()
export class AgentToolbox {
  readonly tools: readonly AgentTool[];
  private readonly byName: ReadonlyMap<string, AgentTool>;
  private readonly specList: AgentToolSpec[];

  constructor(
    store: AgentStore,
    private readonly logger: AppLogger,
  ) {
    this.tools = [...attachmentTools(store), timeTool(), presentTool(store)];
    this.byName = new Map(this.tools.map((t) => [t.name, t]));
    this.specList = this.tools.map(specOf);
  }

  specs(): AgentToolSpec[] {
    return this.specList;
  }

  /** Whether a tool's answer is a *source* `present` can lay out. */
  isSource(name: string): boolean {
    return this.byName.get(name)?.source ?? false;
  }

  /** Tool name → what the step is called on the page. */
  summaries(): ReadonlyMap<string, string> {
    return new Map(this.tools.map((t) => [t.name, t.summary]));
  }

  async run(
    name: string,
    rawArguments: string,
    context: ToolContext,
  ): Promise<ToolOutcome | { kind: 'error'; message: string }> {
    const found = this.byName.get(name);
    if (!found) return { kind: 'error', message: `There is no tool named ${name}.` };

    let args: unknown;
    try {
      args = rawArguments.trim() === '' ? {} : JSON.parse(rawArguments);
    } catch {
      return { kind: 'error', message: 'The arguments were not valid JSON.' };
    }
    const parsed = found.schema.safeParse(args);
    if (!parsed.success) return { kind: 'error', message: `Invalid arguments — ${describeIssues(parsed.error)}` };

    try {
      return await found.run(context, parsed.data);
    } catch (error) {
      if (error instanceof ToolError || error instanceof AppError) return { kind: 'error', message: error.message };
      this.logger.error('agent tool failed', {
        tool: name,
        err: error instanceof Error ? error.message : String(error),
      });
      return { kind: 'error', message: 'The tool failed unexpectedly. Nothing was changed.' };
    }
  }
}
