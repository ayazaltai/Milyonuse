import { createHash } from 'node:crypto';
import { AppLogger } from '../../common/logging/logger.js';
import {
  type AgentModel,
  AgentModelError,
  type AgentModelMessage,
  type AgentModelRequest,
  type AgentModelResult,
  type AgentToolCall,
  type AgentModelUsage,
} from './agent-model.port.js';
import { tierOf } from './models.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
/** A cache breakpoint, as Anthropic's models take it through the router. */
const EPHEMERAL = { type: 'ephemeral' } as const;
/** Per call. A turn makes a few, inside its own limit (agent.service.ts). */
const TIMEOUT_MS = 60_000;

type Fetch = typeof fetch;

/** One chunk of a streamed answer, as the router sends it. */
interface StreamChunk {
  model?: string;
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] | null;
    };
    error?: { code?: number | string; message?: string } | null;
  }[];
  usage?: RouterResponse['usage'];
  error?: { code?: number | string; message?: string };
}

interface RouterResponse {
  model?: string;
  choices?: {
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] | null;
    };
    error?: { code?: number | string; message?: string } | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
  };
  error?: { code?: number | string; message?: string };
}

/**
 * The live agent model: OpenRouter's chat completions (D-03; ported from
 * App-Milyonus `modules/agent/openrouter.model.ts`).
 *
 * This file, and only this file, knows the router's request shape. What it
 * asks for on every call:
 *
 *   Tools, and the model decides. The agent's tools are its only way to see
 *   or propose anything; plain text is its answer to the person.
 *
 *   `provider.data_collection: "deny"`, always. A request carries a person's
 *   own words and files; the router sends it only to providers that do not
 *   keep or train on inputs.
 *
 *   `provider.zdr`, unless switched off (AGENT_ZERO_RETENTION). Only endpoints
 *   that retain nothing at all. Some models have none; then the call fails
 *   with the router's reason rather than going somewhere that keeps data.
 *
 *   Usage accounting. Tokens and the router's own cost come back with every
 *   answer and are recorded (usage_daily, agent_messages) — a new kind of
 *   spend is a meter from its first request.
 *
 * The person is sent as a digest of their member id: enough for the router to
 * tell one user's abuse from another's, nothing that names anyone.
 */
export class OpenRouterAgentModel implements AgentModel {
  readonly name = 'openrouter' as const;

  constructor(
    private readonly apiKey: string,
    private readonly options: { appUrl: string; zeroRetention: boolean },
    private readonly logger: AppLogger,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async complete(request: AgentModelRequest): Promise<AgentModelResult> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          // The router's attribution headers: which app is calling.
          'http-referer': this.options.appUrl,
          'x-title': 'Milyonuse',
        },
        body: JSON.stringify({ ...this.body(request), ...(request.onText ? { stream: true } : {}) }),
      });
    } catch (error) {
      if (timeout.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
        throw new AgentModelError('timeout', 'The model took too long to answer. Try again.', {
          cause: error,
        });
      }
      throw new AgentModelError(
        'connection_failed',
        'The agent could not reach its model. Try again shortly.',
        {
          cause: error,
        },
      );
    }

    if (response.ok && request.onText && response.body) {
      return this.streamed(response, request, timeout);
    }
    const body = (await response.json().catch(() => null)) as RouterResponse | null;
    if (!response.ok) throw this.refusal(response.status, body);
    if (!body)
      throw new AgentModelError(
        'output_invalid',
        'The model’s answer could not be read. Try again.',
      );

    const usage = usageOf(body);
    const choice = body.choices?.[0];
    if (!choice)
      throw new AgentModelError('output_empty', 'The model gave no answer. Try again.', { usage });
    if (choice.error) {
      this.logger.warn('agent model answered with an error', {
        code: choice.error.code,
        reason: choice.error.message,
      });
      throw new AgentModelError(
        'provider_error',
        'The model’s provider failed mid-answer. Try again.',
        { usage },
      );
    }

    const toolCalls: AgentToolCall[] = (choice.message?.tool_calls ?? []).map((call, index) => ({
      id: call.id || `call_${index}`,
      name: call.function?.name ?? '',
      arguments: call.function?.arguments ?? '{}',
    }));

    return {
      text: choice.message?.content ?? '',
      toolCalls,
      ...(choice.message?.reasoning ? { reasoning: choice.message.reasoning.slice(0, 40_000) } : {}),
      finishReason: choice.finish_reason ?? 'stop',
      usage,
      servedModel: body.model ?? request.model,
    };
  }

  /**
   * A streamed answer: server-sent chunks, each a small piece of the
   * answer — text handed on as it comes, tool calls assembled from their
   * pieces, the reasoning gathered, and the usage from the last chunk. The
   * router's keep-alive comments are skipped.
   */
  private async streamed(
    response: Response,
    request: AgentModelRequest,
    timeout: AbortSignal,
  ): Promise<AgentModelResult> {
    let text = '';
    let reasoning = '';
    let finishReason = 'stop';
    let servedModel = request.model;
    let usage: AgentModelUsage = { input: 0, output: 0, cached: 0, costUsd: null };
    const calls: { id: string; name: string; arguments: string }[] = [];

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const take = (line: string): boolean => {
      if (!line.startsWith('data:')) return false;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return true;
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(data) as StreamChunk;
      } catch {
        return false;
      }
      if (chunk.usage) usage = usageOf(chunk as RouterResponse);
      if (chunk.model) servedModel = chunk.model;
      const failure = chunk.error ?? chunk.choices?.[0]?.error;
      if (failure) {
        this.logger.warn('agent model answered with an error', { code: failure.code, reason: failure.message });
        throw new AgentModelError('provider_error', 'The model’s provider failed mid-answer. Try again.', { usage });
      }
      const choice = chunk.choices?.[0];
      if (!choice) return false;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      if (delta.content) {
        text += delta.content;
        request.onText!(delta.content);
      }
      if (delta.reasoning) reasoning += delta.reasoning;
      for (const part of delta.tool_calls ?? []) {
        const at = part.index ?? calls.length;
        const call = (calls[at] ??= { id: '', name: '', arguments: '' });
        if (part.id) call.id = part.id;
        if (part.function?.name) call.name += part.function.name;
        if (part.function?.arguments) call.arguments += part.function.arguments;
      }
      return false;
    };

    try {
      for (let done = false; !done; ) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while (!done && (end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end).replace(/\r$/, '');
          buffer = buffer.slice(end + 1);
          done = take(line);
        }
      }
    } catch (error) {
      if (error instanceof AgentModelError) throw error;
      if (timeout.aborted) {
        throw new AgentModelError('timeout', 'The model took too long to answer. Try again.', { usage });
      }
      throw new AgentModelError('connection_failed', 'The answer was cut off. Try again shortly.', {
        cause: error,
        usage,
      });
    }

    return {
      text,
      toolCalls: calls
        .filter((c) => c.name)
        .map((c, index) => ({ id: c.id || `call_${index}`, name: c.name, arguments: c.arguments || '{}' })),
      ...(reasoning ? { reasoning: reasoning.slice(0, 40_000) } : {}),
      finishReason,
      usage,
      servedModel,
    };
  }

  /** The request, in the router's shape. Exported through the class for tests only. */
  body(request: AgentModelRequest): Record<string, unknown> {
    return {
      model: request.model,
      messages: this.cached(request),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
            tool_choice: 'auto',
          }
        : {}),
      max_tokens: request.maxTokens,
      temperature: 0.2,
      // Models that reason return it; others ignore this. The Deep tier thinks harder.
      reasoning: { effort: tierOf(request.model) === 'deep' ? 'high' : 'low' },
      provider: {
        data_collection: 'deny',
        ...(this.options.zeroRetention ? { zdr: true } : {}),
      },
      usage: { include: true },
      user: createHash('sha256')
        .update(`milyonuse-agent:${request.user}`)
        .digest('hex')
        .slice(0, 32),
    };
  }

  /**
   * The conversation in the router's shape, with caching asked for where the
   * provider needs to be asked. Anthropic's models cache only up to an
   * explicit breakpoint: one after the stable instructions — the tools before
   * them are cached with them — and one on the person's latest message, so
   * every later step of the turn reads all of that from the cache. Other
   * providers cache a repeated prefix by themselves; they are sent plain text.
   */
  private cached(request: AgentModelRequest): Record<string, unknown>[] {
    const messages = request.messages.map(toRouterMessage);
    const n = request.cacheablePrefix ?? 0;
    if (!request.model.startsWith('anthropic/') || n <= 0 || n >= request.system.length) {
      return [{ role: 'system', content: request.system }, ...messages];
    }
    const lastPerson = messages.map((m) => m['role']).lastIndexOf('user');
    if (lastPerson >= 0 && request.tools.length > 0) {
      messages[lastPerson] = {
        role: 'user',
        content: [
          { type: 'text', text: messages[lastPerson]!['content'], cache_control: EPHEMERAL },
        ],
      };
    }
    return [
      {
        role: 'system',
        content: [
          { type: 'text', text: request.system.slice(0, n), cache_control: EPHEMERAL },
          { type: 'text', text: request.system.slice(n) },
        ],
      },
      ...messages,
    ];
  }

  /** What an HTTP refusal means, in the product's words; the router's own reason goes to the log. */
  private refusal(status: number, body: RouterResponse | null): AgentModelError {
    const detail = body?.error?.message ?? null;
    this.logger.warn('agent model refused', { status, reason: detail?.slice(0, 300) });
    switch (status) {
      case 400:
        return new AgentModelError(
          'request_rejected',
          'The model could not take this request. Try another model, or rephrase.',
        );
      case 401:
        return new AgentModelError(
          'not_authorised',
          'The agent’s model key was not accepted. Milyonuse needs to check it.',
        );
      case 402:
        return new AgentModelError(
          'out_of_credit',
          'The agent’s model account is out of credit. Milyonuse needs to top it up.',
        );
      case 403:
        return new AgentModelError('moderated', 'The model’s provider declined this request.');
      case 404:
        return new AgentModelError(
          'no_endpoint',
          'No provider serves this model under the privacy settings the agent requires. Choose another model.',
        );
      case 408:
        return new AgentModelError('timeout', 'The model took too long to answer. Try again.');
      case 429:
        return new AgentModelError(
          'rate_limited',
          'The model is busy right now. Try again in a moment.',
        );
      default:
        return new AgentModelError(
          `provider_${status}`,
          'The model’s provider is unavailable. Try again shortly.',
        );
    }
  }
}

function toRouterMessage(message: AgentModelMessage): Record<string, unknown> {
  if (message.role === 'user') return { role: 'user', content: message.content };
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      name: message.name,
      content: message.content,
    };
  }
  return {
    role: 'assistant',
    content: message.content || null,
    ...(message.toolCalls.length > 0
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {}),
  };
}

function usageOf(body: RouterResponse): AgentModelUsage {
  const input = Math.max(0, Math.round(body.usage?.prompt_tokens ?? 0));
  return {
    input,
    output: Math.max(0, Math.round(body.usage?.completion_tokens ?? 0)),
    cached: Math.min(
      input,
      Math.max(0, Math.round(body.usage?.prompt_tokens_details?.cached_tokens ?? 0)),
    ),
    costUsd: typeof body.usage?.cost === 'number' && body.usage.cost >= 0 ? body.usage.cost : null,
  };
}
