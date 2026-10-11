/**
 * The boundary to the model the agent talks through (D-03; ported from
 * App-Milyonus `modules/agent/agent-model.port.ts`).
 *
 * Everything above this file speaks in these terms, and only an
 * implementation knows a provider's request shape. The live one is a model
 * router (OpenRouter), so a model is chosen by its identifier —
 * `anthropic/claude-sonnet-5-5` — and changing it is configuration, not code.
 */

export interface AgentToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments, generated from the tool's zod schema. */
  parameters: Record<string, unknown>;
}

export interface AgentToolCall {
  /** The model's own id for the call; the answer names it. */
  id: string;
  name: string;
  /** As the model wrote them — parsed and validated by the tool, never trusted. */
  arguments: string;
}

export type AgentModelMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: AgentToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface AgentModelRequest {
  model: string;
  system: string;
  /**
   * How many characters at the start of `system` are the same on every call
   * — the product's instructions. A provider
   * that caches by explicit breakpoints is told to cache up to here.
   */
  cacheablePrefix?: number | undefined;
  messages: AgentModelMessage[];
  tools: AgentToolSpec[];
  maxTokens: number;
  /** Who is asking, as an opaque id — for the router's abuse detection, never a name. */
  user: string;
  signal?: AbortSignal | undefined;
  /**
   * The answer's text as it is written. Given, the model is asked to
   * stream and each new piece is handed here; the result is the whole answer
   * all the same.
   */
  onText?: ((delta: string) => void) | undefined;
}

/** What one call spent, as the router reported it. */
export interface AgentModelUsage {
  input: number;
  output: number;
  /** Tokens read from the provider's prompt cache, included in `input`. */
  cached: number;
  /** In US dollars, when the router says. */
  costUsd: number | null;
}

export interface AgentModelResult {
  text: string;
  toolCalls: AgentToolCall[];
  /** How the model worked toward this answer, when its provider returns it — shown to the person as steps. */
  reasoning?: string | undefined;
  /** `stop`, `tool_calls`, `length`, … — as normalised by the router. */
  finishReason: string;
  usage: AgentModelUsage;
  /** The model that actually answered — a router may fall back. */
  servedModel: string;
}

export interface AgentModel {
  /** Where answers come from: the router, the development stand-in, or nowhere. */
  readonly name: 'openrouter' | 'development' | 'unconfigured';
  complete(request: AgentModelRequest): Promise<AgentModelResult>;
}

/**
 * A call that did not produce a usable answer. `usage` is what it spent
 * anyway, when the model got as far as answering; the turn counts it.
 */
export class AgentModelError extends Error {
  readonly usage: AgentModelUsage | null;

  constructor(
    readonly reason: string,
    /** Said to the person, in the product's words. */
    readonly publicMessage: string,
    options?: { cause?: unknown; usage?: AgentModelUsage | undefined },
  ) {
    super(reason, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AgentModelError';
    this.usage = options?.usage ?? null;
  }
}

export const AGENT_MODEL = Symbol('AGENT_MODEL');
