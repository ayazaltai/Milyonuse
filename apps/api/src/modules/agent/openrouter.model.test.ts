import { describe, expect, it } from 'vitest';
import { AppLogger } from '../../common/logging/logger.js';
import { AgentModelError, type AgentModelRequest } from './agent-model.port.js';
import { OpenRouterAgentModel } from './openrouter.model.js';

/**
 * The one file that knows the model router's request shape: what it
 * sends — privacy settings on every call, tools, no name for the person — and
 * how it reads an answer and a refusal.
 */

const logger = new AppLogger('error');

const request: AgentModelRequest = {
  model: 'anthropic/claude-sonnet-5',
  system: 'You are Milyonuse.',
  messages: [
    { role: 'user', content: 'Open a position' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'list_workspaces', arguments: '{}' }],
    },
    { role: 'tool', toolCallId: 'call_1', name: 'list_workspaces', content: '{"items":[]}' },
  ],
  tools: [
    {
      name: 'list_workspaces',
      description: 'Workspaces',
      parameters: { type: 'object', properties: {} },
    },
  ],
  maxTokens: 4096,
  user: '01JBXR4K8ZQW3E7NDYVM5TGHPA',
};

function respond(
  status: number,
  body: unknown,
): { fetch: typeof fetch; sent: { url: string; init: RequestInit }[] } {
  const sent: { url: string; init: RequestInit }[] = [];
  const fake = ((url: string, init: RequestInit) => {
    sent.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetch: fake, sent };
}

describe('the request', () => {
  it('asks for tools, and never for a provider that keeps or trains on the data', async () => {
    const { fetch, sent } = respond(200, {
      model: 'anthropic/claude-sonnet-5',
      choices: [{ finish_reason: 'stop', message: { content: 'Done.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    await new OpenRouterAgentModel(
      'sk-test',
      { appUrl: 'https://app.milyonuse.com', zeroRetention: true },
      logger,
      fetch,
    ).complete(request);

    const { url, init } = sent[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-test');
    expect(headers['http-referer']).toBe('https://app.milyonuse.com');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'anthropic/claude-sonnet-5',
      tool_choice: 'auto',
      max_tokens: 4096,
      provider: { data_collection: 'deny', zdr: true },
      usage: { include: true },
    });
    expect(body['tools']).toEqual([
      {
        type: 'function',
        function: {
          name: 'list_workspaces',
          description: 'Workspaces',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);
    // The system prompt first, then the conversation in the router's shape.
    expect(body['messages']).toEqual([
      { role: 'system', content: 'You are Milyonuse.' },
      { role: 'user', content: 'Open a position' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'list_workspaces', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'list_workspaces', content: '{"items":[]}' },
    ]);
    // The person is a digest, not a member id and never a name.
    expect(body['user']).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(body)).not.toContain(request.user);
  });

  it('leaves zero retention out only when told to', () => {
    const model = new OpenRouterAgentModel('k', { appUrl: 'x', zeroRetention: false }, logger);
    expect(model.body(request)['provider']).toEqual({ data_collection: 'deny' });
  });
});

describe('caching and thinking', () => {
  const model = new OpenRouterAgentModel('k', { appUrl: 'x', zeroRetention: true }, logger);
  const stable = 'You are Milyonuse.';
  const cacheable: AgentModelRequest = {
    ...request,
    system: `${stable}\n\nNow: 2026-10-04T09:30:12.345Z (UTC)`,
    cacheablePrefix: stable.length,
  };

  it('asks an Anthropic model to cache the instructions, and the conversation up to the person’s latest message', () => {
    const messages = model.body(cacheable)['messages'] as Record<string, unknown>[];
    expect(messages[0]).toEqual({
      role: 'system',
      content: [
        { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: '\n\nNow: 2026-10-04T09:30:12.345Z (UTC)' },
      ],
    });
    expect(messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Open a position', cache_control: { type: 'ephemeral' } }],
    });
    // The steps after it are sent as they are; two breakpoints of the four allowed.
    expect(messages[3]).toMatchObject({ role: 'tool', content: '{"items":[]}' });
    expect(JSON.stringify(messages).match(/cache_control/g)).toHaveLength(2);
  });

  it('sends other providers plain text — they cache a repeated prefix by themselves', () => {
    const messages = model.body({ ...cacheable, model: 'openai/gpt-5' })['messages'] as Record<
      string,
      unknown
    >[];
    expect(messages[0]).toEqual({ role: 'system', content: cacheable.system });
    expect(JSON.stringify(messages)).not.toContain('cache_control');
  });

  it('caches nothing it was not told is stable, nor a call without tools (a summary)', () => {
    expect(JSON.stringify(model.body(request)['messages'])).not.toContain('cache_control');
    const summary = model.body({ ...cacheable, tools: [] })['messages'] as Record<
      string,
      unknown
    >[];
    expect(summary[1]).toEqual({ role: 'user', content: 'Open a position' });
  });

  it('thinks harder on the Deep tier, lightly otherwise', () => {
    expect(model.body(request)['reasoning']).toEqual({ effort: 'low' });
    expect(model.body({ ...request, model: 'anthropic/claude-haiku-4.5' })['reasoning']).toEqual({
      effort: 'low',
    });
    expect(model.body({ ...request, model: 'anthropic/claude-opus-5' })['reasoning']).toEqual({
      effort: 'high',
    });
  });
});

describe('the answer', () => {
  it('reads tool calls, text, the model that answered and what it cost', async () => {
    const { fetch } = respond(200, {
      model: 'anthropic/claude-sonnet-5-20260630',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: 'Looking.',
            tool_calls: [
              {
                id: 'c9',
                type: 'function',
                function: { name: 'list_positions', arguments: '{"status":"open"}' },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 80,
        cost: 0.0042,
        prompt_tokens_details: { cached_tokens: 1000 },
      },
    });
    const result = await new OpenRouterAgentModel(
      'k',
      { appUrl: 'x', zeroRetention: true },
      logger,
      fetch,
    ).complete(request);
    expect(result).toEqual({
      text: 'Looking.',
      toolCalls: [{ id: 'c9', name: 'list_positions', arguments: '{"status":"open"}' }],
      finishReason: 'tool_calls',
      usage: { input: 1200, output: 80, cached: 1000, costUsd: 0.0042 },
      servedModel: 'anthropic/claude-sonnet-5-20260630',
    });
  });

  it('counts what an answer that failed mid-way spent', async () => {
    const { fetch } = respond(200, {
      choices: [{ error: { code: 502, message: 'upstream reset' } }],
      usage: { prompt_tokens: 300, completion_tokens: 0 },
    });
    const error = await new OpenRouterAgentModel(
      'k',
      { appUrl: 'x', zeroRetention: true },
      logger,
      fetch,
    )
      .complete(request)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentModelError);
    expect(error).toMatchObject({ reason: 'provider_error', usage: { input: 300, output: 0 } });
  });
});

describe('a refusal', () => {
  it.each([
    [400, 'request_rejected'],
    [401, 'not_authorised'],
    [402, 'out_of_credit'],
    [403, 'moderated'],
    [404, 'no_endpoint'],
    [408, 'timeout'],
    [429, 'rate_limited'],
    [503, 'provider_503'],
  ])('HTTP %i is %s, said in the product’s words', async (status, reason) => {
    const { fetch } = respond(status, { error: { code: status, message: 'router says no' } });
    const error = await new OpenRouterAgentModel(
      'k',
      { appUrl: 'x', zeroRetention: true },
      logger,
      fetch,
    )
      .complete(request)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ reason });
    // The router's own wording goes to the log, not to the person.
    expect((error as AgentModelError).publicMessage).not.toContain('router says no');
  });

  it('a connection that fails is not an answer', async () => {
    const failing = (() =>
      Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    const error = await new OpenRouterAgentModel(
      'k',
      { appUrl: 'x', zeroRetention: true },
      logger,
      failing,
    )
      .complete(request)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: 'connection_failed' });
  });

  it('stops waiting when the turn has no time left', async () => {
    const never = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const error = await new OpenRouterAgentModel(
      'k',
      { appUrl: 'x', zeroRetention: true },
      logger,
      never,
    )
      .complete({ ...request, signal: AbortSignal.timeout(20) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentModelError);
    expect(['timeout', 'connection_failed']).toContain((error as AgentModelError).reason);
  });
});

describe('an answer streamed as it is written', () => {
  /** The router's server-sent events, cut into arbitrary network pieces. */
  function streaming(
    events: unknown[],
    cuts = 7,
  ): { fetch: typeof fetch; sent: { init: RequestInit }[] } {
    const sent: { init: RequestInit }[] = [];
    const text =
      ': OPENROUTER PROCESSING\n\n' +
      events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
    const fake = ((_url: string, init: RequestInit) => {
      sent.push({ init });
      const bytes = new TextEncoder().encode(text);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < bytes.length; i += cuts) controller.enqueue(bytes.slice(i, i + cuts));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    }) as unknown as typeof fetch;
    return { fetch: fake, sent };
  }

  it('hands each piece of text on, assembles tool calls from their pieces, and reads the usage at the end', async () => {
    const { fetch, sent } = streaming([
      {
        model: 'anthropic/claude-sonnet-5-20260630',
        choices: [{ delta: { content: 'Looking ' } }],
      },
      { choices: [{ delta: { content: 'it up.', reasoning: 'First the positions.' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'c1', function: { name: 'list_positions', arguments: '{"sta' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'tus":"open"}' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 900, completion_tokens: 40, cost: 0.002 } },
      '[DONE]',
    ]);
    const pieces: string[] = [];
    const result = await new OpenRouterAgentModel(
      'k',
      { appUrl: 'x', zeroRetention: true },
      logger,
      fetch,
    ).complete({
      ...request,
      onText: (d) => pieces.push(d),
    });
    expect(JSON.parse(sent[0]!.init.body as string)).toMatchObject({ stream: true });
    expect(pieces).toEqual(['Looking ', 'it up.']);
    expect(result).toEqual({
      text: 'Looking it up.',
      reasoning: 'First the positions.',
      toolCalls: [{ id: 'c1', name: 'list_positions', arguments: '{"status":"open"}' }],
      finishReason: 'tool_calls',
      usage: { input: 900, output: 40, cached: 0, costUsd: 0.002 },
      servedModel: 'anthropic/claude-sonnet-5-20260630',
    });
  });

  it('is not asked for when nobody reads the pieces', async () => {
    const { fetch, sent } = respond(200, { choices: [{ message: { content: 'ok' } }], usage: {} });
    await new OpenRouterAgentModel(
      'k',
      { appUrl: 'x', zeroRetention: true },
      logger,
      fetch,
    ).complete(request);
    expect(JSON.parse(sent[0]!.init.body as string)['stream']).toBeUndefined();
  });

  it('says so when the provider fails mid-answer, counting what it spent', async () => {
    const { fetch } = streaming([
      {
        choices: [{ delta: { content: 'Partly' } }],
        usage: { prompt_tokens: 500, completion_tokens: 3 },
      },
      { error: { code: 502, message: 'upstream reset' } },
    ]);
    const error = await new OpenRouterAgentModel(
      'k',
      { appUrl: 'x', zeroRetention: true },
      logger,
      fetch,
    )
      .complete({ ...request, onText: () => undefined })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: 'provider_error', usage: { input: 500, output: 3 } });
  });
});
