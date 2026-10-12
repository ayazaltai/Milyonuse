import type { Principal } from '@milyonuse/contracts';
import type { z } from 'zod';
import { AppError } from '../../common/app-error.js';
import {
  type AgentModel,
  AgentModelError,
  type AgentModelMessage,
  type AgentModelUsage,
  type AgentToolSpec,
} from '../agent/agent-model.port.js';
import type { ToolSet } from '../agent/agent.toolbox.js';
import type { AgentToolbox } from '../agent/agent.toolbox.js';
import { forModel, keepAnswer } from '../agent/answers.js';
import type { ActionService } from '../agent/actions/action.service.js';
import type { ToolContext } from '../agent/tools/tool.js';
import type { MemoryService } from '../memory/memory.service.js';
import { describeIssues } from '../agent/tools/tool.js';

/** What one call of a team turn may write. */
const TURN_OUTPUT_TOKENS = 8_000;
/** What a turn rereads of each tool answer. */
const ANSWER_CHARS = 8_000;
const CALL_TIMEOUT_MS = 100_000;

/** A tool only the engine has — plan_tasks, merge_results, approve_result … — whose answer changes the run. */
export interface EngineTool {
  spec: AgentToolSpec;
  schema: z.ZodType;
  /** Answers the model; `done` ends the turn with what the engine took from the call. */
  handle(args: Record<string, unknown>): Promise<{ answer: unknown; done?: boolean }>;
}

export class TurnFailed extends Error {
  constructor(
    message: string,
    readonly tokens: number,
  ) {
    super(message);
    this.name = 'TurnFailed';
  }
}

/** Raised before a model call the run cannot afford: the run waits for the person. */
export class BudgetExhausted extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'BudgetExhausted';
  }
}

export interface TurnOutcome {
  text: string;
  /** An engine tool ended the turn. */
  done: boolean;
  tokensIn: number;
  tokensOut: number;
  calls: { name: string; ok: boolean }[];
  proposals: number;
}

export interface TurnDeps {
  model: AgentModel;
  toolbox: AgentToolbox;
  actions: ActionService;
  memory: MemoryService;
}

/**
 * One agent's turn inside a team run: the model, its own tools and the
 * engine's, a few rounds at most. It runs unattended, so every tool call goes
 * through the RiskEngine under the agent's unattended policy: a safe read runs
 * (and taints the run), anything else becomes a card on the run's
 * conversation for the person — never run on the member's word. Nothing the
 * turn reads is an instruction to the engine: tool answers come back as data.
 */
export async function teamTurn(
  deps: TurnDeps,
  input: {
    principal: Principal;
    model: string;
    system: string;
    messages: AgentModelMessage[];
    toolset: ToolSet;
    engineTools?: EngineTool[] | undefined;
    context: ToolContext;
    unattended: { policy: 'safe_only' | 'trusted' };
    maxRounds: number;
    /** Before every call: throws BudgetExhausted when the run cannot afford one more. */
    afford: () => Promise<void>;
    /** After every call: what it spent, counted to the run and the person's day. */
    spent: (usage: AgentModelUsage | null) => Promise<void>;
    signal?: AbortSignal;
  },
): Promise<TurnOutcome> {
  const engine = new Map((input.engineTools ?? []).map((t) => [t.spec.name, t]));
  const tools = [...input.toolset.specs(), ...[...engine.values()].map((t) => t.spec)];
  const messages = [...input.messages];
  const outcome: TurnOutcome = { text: '', done: false, tokensIn: 0, tokensOut: 0, calls: [], proposals: 0 };

  for (let round = 0; round < input.maxRounds; round += 1) {
    await input.afford();
    let result;
    try {
      result = await deps.model.complete({
        model: input.model,
        system: input.system,
        messages,
        tools,
        maxTokens: TURN_OUTPUT_TOKENS,
        user: input.principal.memberId,
        signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]) : AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (error) {
      if (!(error instanceof AgentModelError)) throw error;
      await input.spent(error.usage);
      throw new TurnFailed(error.publicMessage, outcome.tokensIn + outcome.tokensOut);
    }
    outcome.tokensIn += result.usage.input;
    outcome.tokensOut += result.usage.output;
    await input.spent(result.usage);
    messages.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls });
    if (result.toolCalls.length === 0) {
      outcome.text = result.text;
      return outcome;
    }

    for (const call of result.toolCalls) {
      let answer: string;
      const own = engine.get(call.name);
      if (own) {
        const parsed = own.schema.safeParse(parse(call.arguments));
        if (!parsed.success) {
          answer = JSON.stringify({ error: `Invalid arguments — ${describeIssues(parsed.error)}` });
          outcome.calls.push({ name: call.name, ok: false });
        } else {
          try {
            const handled = await own.handle(parsed.data as Record<string, unknown>);
            answer = keepAnswer(handled.answer);
            outcome.calls.push({ name: call.name, ok: true });
            if (handled.done) {
              outcome.done = true;
              outcome.text = result.text;
              return outcome;
            }
          } catch (error) {
            if (!(error instanceof AppError) && !(error instanceof RangeError)) throw error;
            answer = JSON.stringify({ error: error.message });
            outcome.calls.push({ name: call.name, ok: false });
          }
        }
      } else {
        answer = await runTool(deps, input, call.name, call.arguments, outcome);
      }
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: forModel(answer, call.name, ANSWER_CHARS) });
    }
  }
  throw new TurnFailed('It took more steps than one task allows without finishing.', outcome.tokensIn + outcome.tokensOut);
}

async function runTool(
  deps: TurnDeps,
  input: Parameters<typeof teamTurn>[1],
  name: string,
  raw: string,
  outcome: TurnOutcome,
): Promise<string> {
  const prepared = input.toolset.prepare(name, raw);
  if (prepared.kind === 'error') {
    outcome.calls.push({ name, ok: false });
    return JSON.stringify({ error: prepared.message });
  }
  const { tool, args } = prepared;
  const verdict = deps.actions.classify(tool, args, 'ask', input.unattended);
  if (verdict.decision === 'block') {
    outcome.calls.push({ name, ok: false });
    return JSON.stringify({ error: `Not run: ${verdict.reason}.` });
  }
  if (verdict.decision === 'auto' && verdict.risk === 'safe') {
    const result = await deps.toolbox.execute(tool, args, input.context);
    if (result.kind === 'error') {
      outcome.calls.push({ name, ok: false });
      return JSON.stringify({ error: result.message });
    }
    if (result.reads?.length) {
      await deps.memory.recordTaint(input.principal, { conversationId: input.context.conversationId, runId: input.context.runId }, result.reads);
    }
    outcome.calls.push({ name, ok: true });
    return keepAnswer(result.data);
  }
  try {
    const action = await deps.actions.propose(input.principal, input.context, tool, args, verdict);
    outcome.calls.push({ name, ok: true });
    if (action.status === 'proposed') {
      outcome.proposals += 1;
      return keepAnswer({
        proposed: true,
        title: action.preview.title,
        note: 'Put on a card for the person after the run. It has NOT been done. Describe it in your result as waiting for their confirmation.',
      });
    }
    return keepAnswer({ status: action.status, result: action.result, error: action.error });
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    outcome.calls.push({ name, ok: false });
    return JSON.stringify({ error: error.message });
  }
}

function parse(raw: string): unknown {
  try {
    return raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    return null;
  }
}
