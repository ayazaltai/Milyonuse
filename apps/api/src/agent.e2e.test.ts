import { strToU8, zipSync } from 'fflate';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AgentAttachmentView,
  AgentCompaction,
  AgentConversationSummary,
  AgentConversationView,
  AgentSearchHit,
  AgentStatus,
  AgentStreamEvent,
  AgentTurn,
} from '@milyonuse/contracts';
import { AppLogger } from './common/logging/logger.js';
import { loadEnv } from './config/env.js';
import { APP_URL, PLATFORM_URL } from './database/database.testing.js';
import {
  AGENT_MODEL,
  type AgentModel,
  AgentModelError,
  type AgentModelRequest,
  type AgentModelResult,
} from './modules/agent/agent-model.port.js';
import { agentModelFor } from './modules/model/model.module.js';
import { AgentController } from './modules/agent/agent.controller.js';
import { AgentService, CUT_CALL } from './modules/agent/agent.service.js';
import { SUMMARY_INSTRUCTIONS } from './modules/agent/context.js';
import { type TestApp, createTestApp, lastMail, sessionOf, tokenIn } from './testing/test-app.js';

/**
 * The agent over HTTP, with a scripted model in place of the router: each
 * test says what the model will answer or ask for, and checks what the
 * product kept, showed and spent — and that nobody else can see any of it.
 */

const suffix = Date.now().toString(36);
const PASSWORD = 'correct horse battery staple';
const platform = new pg.Pool({ connectionString: PLATFORM_URL, max: 2 });
const tenant = new pg.Pool({ connectionString: APP_URL, max: 2 });

// ───────────────────────────────────────────────────────── the scripted model

type Step = (request: AgentModelRequest) => AgentModelResult | Promise<AgentModelResult>;
const script: Step[] = [];
const seen: AgentModelRequest[] = [];
const usage = { input: 120, output: 30, cached: 20, costUsd: 0.0015 };
const MODEL = 'anthropic/claude-sonnet-5-5';

const call =
  (name: string, args: Record<string, unknown> | string, finishReason = 'tool_calls'): Step =>
  () => ({
    text: '',
    toolCalls: [
      {
        id: `call_${Math.random().toString(36).slice(2, 8)}`,
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
      },
    ],
    finishReason,
    usage,
    servedModel: MODEL,
  });
const say =
  (text: string, finishReason = 'stop'): Step =>
  (request) => {
    request.onText?.(text.slice(0, Math.ceil(text.length / 2)));
    request.onText?.(text.slice(Math.ceil(text.length / 2)));
    return { text, toolCalls: [], finishReason, usage, servedModel: MODEL };
  };
const fail =
  (reason: string, message = 'The model is busy right now. Try again in a moment.'): Step =>
  () => {
    throw new AgentModelError(reason, message);
  };
/** A step that answers only when the turn is told to stop. */
const hang: Step = (request) =>
  new Promise((_, reject) => {
    request.signal?.addEventListener('abort', () => reject(new AgentModelError('aborted', 'Stopped.')));
  });

const scripted: AgentModel = {
  name: 'openrouter',
  async complete(request) {
    seen.push(request);
    const step = script.shift();
    if (!step) throw new Error('The scripted model has nothing more to say');
    return step(request);
  },
};

// ────────────────────────────────────────────────────────────────── helpers

let api: TestApp;
let ada: string;
let grace: string;

/** The address a test person registers with: `ada-<run>@agent.e2e.test`. */
function emailOf(handle: string): string {
  return `${handle}-${suffix}@agent.e2e.test`;
}

/**
 * Registers someone. A suite that sends many turns signs up its own Ada: the
 * per-member limit (20 turns a minute) is real, and one person across the
 * whole file would meet it.
 */
async function signUp(app: TestApp, name: string, handle = name.split(' ')[0]!.toLowerCase()): Promise<string> {
  const email = emailOf(handle);
  const registered = await app.request('POST', '/auth/register', {
    payload: { name, email, password: PASSWORD, acceptTerms: true, timeZone: 'Europe/Istanbul' },
  });
  expect(registered.statusCode, registered.body).toBe(202);
  const verified = await app.request('POST', '/auth/verify', {
    payload: { token: tokenIn(lastMail(app.outbox, email), 'verify') },
  });
  expect(verified.statusCode, verified.body).toBe(201);
  return sessionOf(verified)!;
}

async function conversation(cookie = ada, payload: Record<string, unknown> = {}): Promise<AgentConversationSummary> {
  const response = await api.request('POST', '/agent/conversations', { cookie, payload });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<AgentConversationSummary>();
}

async function turn(
  conversationId: string,
  content: string,
  steps: Step[],
  extra: Record<string, unknown> = {},
  cookie = ada,
): Promise<AgentTurn> {
  script.push(...steps);
  const response = await api.request('POST', `/agent/conversations/${conversationId}/messages`, {
    cookie,
    payload: { content, ...extra },
  });
  expect(response.statusCode, response.body).toBe(201);
  expect(script).toHaveLength(0);
  return response.json<AgentTurn>();
}

async function view(conversationId: string, cookie = ada): Promise<AgentConversationView> {
  const response = await api.request('GET', `/agent/conversations/${conversationId}`, { cookie });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<AgentConversationView>();
}

async function attachText(conversationId: string, name: string, text: string, cookie = ada) {
  const response = await api.request('POST', `/agent/conversations/${conversationId}/attachments`, {
    cookie,
    payload: { name, text },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<AgentAttachmentView>();
}

function upload(conversationId: string, fileName: string, type: string, body: Uint8Array | string, cookie = ada) {
  return api.app.inject({
    method: 'POST',
    url: `/api/v1/agent/conversations/${conversationId}/attachments?fileName=${encodeURIComponent(fileName)}`,
    headers: { 'content-type': type, 'x-forwarded-for': api.address },
    cookies: { mu_session: cookie },
    payload: typeof body === 'string' ? body : Buffer.from(body),
  });
}

/** The events of a server-sent stream, in order. */
function eventsOf(body: string): AgentStreamEvent[] {
  return body
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice(6)) as AgentStreamEvent);
}

function docx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('');
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`),
  });
}

/** Today's agent tokens for a person, as usage_daily counts them. */
async function tokensToday(cookie: string): Promise<number> {
  const status = await api.request('GET', '/agent', { cookie });
  return status.json<AgentStatus>().allowance.tokens.used;
}

// ────────────────────────────────────────────────────────────────── set-up

beforeAll(async () => {
  AgentService.stopPollMs = 50;
  AgentController.keepAliveMs = 20;
  api = await createTestApp(
    {
      AGENT_MODEL: MODEL,
      AGENT_MODELS: `anthropic/claude-haiku-5-5,${MODEL},anthropic/claude-opus-5-5`,
      // The smallest window there is (≈24,000 characters), so a few long messages outgrow it.
      AGENT_CONTEXT_TOKENS: '8000',
    },
    [{ provide: AGENT_MODEL, useValue: scripted }],
  );
  ada = await signUp(api, 'Ada Lovelace');
  grace = await signUp(api, 'Grace Hopper');
}, 90_000);

afterAll(async () => {
  await platform.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${suffix}@agent.e2e.test`]);
  await Promise.all([api?.close(), platform.end(), tenant.end()]);
});

// ──────────────────────────────────────────────────────────────────── status

describe('the agent’s status', () => {
  it('says it is set up, which models there are in plain words, today’s allowance and the limits', async () => {
    const response = await api.request('GET', '/agent', { cookie: ada });
    expect(response.statusCode).toBe(200);
    const status = response.json<AgentStatus>();
    expect(status).toMatchObject({ configured: true, provider: 'openrouter', defaultModel: MODEL });
    expect(status.reader.name).toBe('Ada Lovelace');
    expect(status.modelOptions.map((m) => [m.label, m.tier])).toEqual([
      ['Fast', 'fast'],
      ['Balanced', 'balanced'],
      ['Deep', 'deep'],
    ]);
    expect(status.allowance.tokens.ceiling).toBe(2_000_000);
    expect(status.limits.roundsPerTurn).toBe(6);
  });

  it('is for signed-in people only', async () => {
    expect((await api.request('GET', '/agent')).statusCode).toBe(401);
  });
});

// ───────────────────────────────────────────────────────────── conversations

describe('conversations', () => {
  it('start with the default model and a placeholder title', async () => {
    const created = await conversation();
    expect(created).toMatchObject({ title: 'New conversation', model: MODEL, pinnedAt: null, summarizedThrough: null });
  });

  it('take a model the deployment offers, and refuse one it does not', async () => {
    expect((await conversation(ada, { model: 'anthropic/claude-opus-5-5' })).model).toBe('anthropic/claude-opus-5-5');
    const refused = await api.request('POST', '/agent/conversations', {
      cookie: ada,
      payload: { model: 'openai/gpt-0' },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ error: { message: string } }>().error.message).toContain('Fast, Balanced, Deep');
  });

  it('are renamed and pinned, and pinned ones come first', async () => {
    const first = await conversation();
    await conversation();
    const renamed = await api.request('PATCH', `/agent/conversations/${first.id}`, {
      cookie: ada,
      payload: { title: 'Trip to Lisbon', pinned: true },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<AgentConversationSummary>()).toMatchObject({ title: 'Trip to Lisbon' });
    const list = (await api.request('GET', '/agent/conversations', { cookie: ada })).json<{
      items: AgentConversationSummary[];
    }>();
    expect(list.items[0]!.id).toBe(first.id);
    const unpinned = await api.request('PATCH', `/agent/conversations/${first.id}`, {
      cookie: ada,
      payload: { pinned: false },
    });
    expect(unpinned.json<AgentConversationSummary>().pinnedAt).toBeNull();
  });

  it('refuse an update that changes nothing, and an id that is not one', async () => {
    const created = await conversation();
    expect(
      (await api.request('PATCH', `/agent/conversations/${created.id}`, { cookie: ada, payload: {} })).statusCode,
    ).toBe(422);
    expect((await api.request('GET', '/agent/conversations/not-an-id', { cookie: ada })).statusCode).toBe(422);
  });

  it('are one person’s: anyone else gets “not found” for every route', async () => {
    const mine = await conversation();
    const base = `/agent/conversations/${mine.id}`;
    const tries = await Promise.all([
      api.request('GET', base, { cookie: grace }),
      api.request('PATCH', base, { cookie: grace, payload: { title: 'Mine now' } }),
      api.request('POST', `${base}/messages`, { cookie: grace, payload: { content: 'Hello' } }),
      api.request('POST', `${base}/attachments`, { cookie: grace, payload: { text: 'a,b\n1,2' } }),
      api.request('POST', `${base}/stop`, { cookie: grace }),
      api.request('GET', `${base}/export`, { cookie: grace }),
      api.request('DELETE', base, { cookie: grace }),
    ]);
    expect(tries.map((r) => r.statusCode)).toEqual([404, 404, 404, 404, 404, 404, 404]);
    const list = (await api.request('GET', '/agent/conversations', { cookie: grace })).json<{
      items: AgentConversationSummary[];
    }>();
    expect(list.items.map((c) => c.id)).not.toContain(mine.id);
    expect(seen.filter((r) => r.messages.some((m) => m.role === 'user' && m.content === 'Hello'))).toHaveLength(0);
  });

  it('are deleted with everything in them', async () => {
    const created = await conversation();
    await turn(created.id, 'Remember this', [say('Noted.')]);
    expect((await api.request('DELETE', `/agent/conversations/${created.id}`, { cookie: ada })).statusCode).toBe(200);
    expect((await api.request('GET', `/agent/conversations/${created.id}`, { cookie: ada })).statusCode).toBe(404);
    const { rows } = await platform.query(`SELECT 1 FROM agent_messages WHERE conversation_id = $1`, [created.id]);
    expect(rows).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────── turns

describe('a turn', () => {
  it('keeps the message and the answer, names the conversation after it, and records what was spent', async () => {
    const created = await conversation();
    const before = await tokensToday(ada);
    const result = await turn(created.id, 'Plan a weekend in Lisbon', [say('Here is a plan.')]);
    expect(result.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Plan a weekend in Lisbon'],
      ['assistant', 'Here is a plan.'],
    ]);
    expect(result.conversation.title).toBe('Plan a weekend in Lisbon');
    expect(result.stopped).toBeNull();
    expect(result.usage).toEqual({ calls: 1, tokensIn: 120, tokensOut: 30, costUsd: 0.0015 });
    expect(await tokensToday(ada)).toBe(before + 150);
    const { rows } = await platform.query<{ model: string; prompt_version: string; tokens_cached: number }>(
      `SELECT model, prompt_version, tokens_cached FROM agent_messages WHERE id = $1`,
      [result.messages[1]!.id],
    );
    expect(rows[0]).toMatchObject({ model: MODEL, tokens_cached: 20 });
    expect(rows[0]!.prompt_version).toMatch(/^milyonuse-/);
  });

  it('tells the model who is asking, when, in which mode — and to answer in English unless spoken to otherwise', async () => {
    const created = await conversation();
    await turn(created.id, 'What should I do first?', [say('Start here.')], { timeZone: 'America/New_York', mode: 'plan' });
    const system = seen.at(-1)!.system;
    expect(system).toContain('Person: Ada Lovelace');
    expect(system).toContain("Person's time zone: America/New_York");
    expect(system).toContain('Mode: Plan.');
    expect(system).toContain('Reply in English unless the person writes in another language');
    expect(seen.at(-1)!.cacheablePrefix).toBeGreaterThan(100);
  });

  it('reads time in the person’s own zone when the page sends none', async () => {
    const created = await conversation();
    await turn(created.id, 'Hello', [say('Hi.')]);
    expect(seen.at(-1)!.system).toContain("Person's time zone: Europe/Istanbul");
  });

  it('runs a tool, keeps its answer, and lets the model read it before answering', async () => {
    const created = await conversation();
    const result = await turn(created.id, 'What time is it in Tokyo?', [
      call('current_time', { timeZone: 'Asia/Tokyo' }),
      say('It is evening in Tokyo.'),
    ]);
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(result.messages[1]!.toolCalls[0]).toMatchObject({ name: 'current_time', summary: 'Checked the time' });
    const answer = JSON.parse(result.messages[2]!.content) as { timeZone: string; local: string };
    expect(answer.timeZone).toBe('Asia/Tokyo');
    expect(answer.local).toContain('UTC+09:00');
    const reread = seen.at(-1)!.messages.at(-1)!;
    expect(reread).toMatchObject({ role: 'tool', name: 'current_time' });
  });

  it('answers the model a refusal it can act on: a tool that does not exist, arguments that do not fit', async () => {
    const created = await conversation();
    const result = await turn(created.id, 'Do things', [
      call('launch_rocket', {}),
      call('current_time', { timeZone: 'Mars/Olympus' }),
      say('I could not.'),
    ]);
    const tools = result.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content) as { error: string });
    expect(tools[0]!.error).toBe('There is no tool named launch_rocket.');
    expect(tools[1]!.error).toBe('Invalid arguments — timeZone: Unknown time zone; use an IANA name such as Europe/Istanbul.');
  });

  it('stops after as many steps as a reply allows, and says so', async () => {
    const created = await conversation();
    const result = await turn(
      created.id,
      'Keep checking the time',
      Array.from({ length: 6 }, () => call('current_time', {})),
    );
    expect(result.stopped).toBe('rounds');
    expect(result.messages.at(-1)!.content).toContain('as many steps as one reply allows');
  });

  it('does not run a call cut off at the output limit, and tells the model why', async () => {
    const created = await conversation();
    const result = await turn(created.id, 'Read everything', [
      call('current_time', '{"timeZone": "Europe/Lon', 'length'),
      say('Let me ask for less.'),
    ]);
    const answer = JSON.parse(result.messages[2]!.content) as { error: string };
    expect(answer.error).toBe(CUT_CALL);
  });

  it('says when its words were cut at the output limit', async () => {
    const created = await conversation();
    const result = await turn(created.id, 'Write a long essay', [say('Once upon a time', 'length')]);
    expect(result.messages[1]!.content).toBe('Once upon a time… (cut short — say “continue” for the rest)');
  });

  it('answers a failing model with agent_model_failed — and keeps the person’s message', async () => {
    const created = await conversation();
    script.push(fail('rate_limited'));
    const response = await api.request('POST', `/agent/conversations/${created.id}/messages`, {
      cookie: ada,
      payload: { content: 'Are you there?' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: 'agent_model_failed',
      message: 'The model is busy right now. Try again in a moment.',
    });
    expect((await view(created.id)).messages.map((m) => m.content)).toEqual(['Are you there?']);
  });

  it('ends where it got to when the model times out after the first step', async () => {
    const created = await conversation();
    const result = await turn(created.id, 'Check and tell me', [call('current_time', {}), fail('timeout')]);
    expect(result.stopped).toBe('time');
    expect(result.messages.at(-1)!.content).toContain('longer than one reply allows');
  });

  it('stops when asked, from any request, keeping what it did', async () => {
    const created = await conversation();
    script.push(call('current_time', {}), hang);
    const running = api.request('POST', `/agent/conversations/${created.id}/messages`, {
      cookie: ada,
      payload: { content: 'Take your time' },
    });
    // Wait until the model is in its second call, then ask to stop.
    for (let i = 0; i < 100 && script.length > 0; i += 1) await new Promise((r) => setTimeout(r, 20));
    const stop = await api.request('POST', `/agent/conversations/${created.id}/stop`, { cookie: ada });
    expect(stop.statusCode).toBe(202);
    const response = await running;
    expect(response.statusCode, response.body).toBe(201);
    const result = response.json<AgentTurn>();
    expect(result.stopped).toBe('stopped');
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(result.messages.at(-1)!.content).toContain('Stopped, as you asked');
  });

  it('refuses an attachment that is not in the conversation', async () => {
    const created = await conversation();
    const response = await api.request('POST', `/agent/conversations/${created.id}/messages`, {
      cookie: ada,
      payload: { content: 'Read this', attachmentIds: ['01J0000000000000000000000Z'] },
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses an empty message', async () => {
    const created = await conversation();
    const response = await api.request('POST', `/agent/conversations/${created.id}/messages`, {
      cookie: ada,
      payload: { content: '   ' },
    });
    expect(response.statusCode).toBe(422);
  });
});

// ──────────────────────────────────────────────────────────────── revisions

describe('an edit', () => {
  it('supersedes what came after the message it revises — kept, folded, and no longer read by the model', async () => {
    const created = await conversation();
    const first = await turn(created.id, 'Suggest a name for my cat', [say('Whiskers.')]);
    await turn(created.id, 'Suggest a name for my dog', [say('Rex.')], { revises: first.messages[0]!.id });
    const read = await view(created.id);
    expect(read.messages.map((m) => [m.content, m.superseded])).toEqual([
      ['Suggest a name for my cat', true],
      ['Whiskers.', true],
      ['Suggest a name for my dog', false],
      ['Rex.', false],
    ]);
    expect(read.messages[2]!.revises).toBe(first.messages[0]!.id);
    const sent = seen.at(-1)!.messages.map((m) => m.content);
    expect(sent).not.toContain('Whiskers.');
    expect(sent).toContain('Suggest a name for my dog');
  });

  it('only revises the person’s own words', async () => {
    const created = await conversation();
    const result = await turn(created.id, 'Hello', [say('Hi there.')]);
    const response = await api.request('POST', `/agent/conversations/${created.id}/messages`, {
      cookie: ada,
      payload: { content: 'Edit', revises: result.messages[1]!.id },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { message: string } }>().error.message).toContain('Only your own message');
  });
});

// ──────────────────────────────────────────────────────────────── streaming

describe('a streamed turn', () => {
  it('tells the turn as it happens: the message, the words as written, the steps, then the whole', async () => {
    const created = await conversation();
    script.push(call('current_time', {}), say('It is now.'));
    const response = await api.request('POST', `/agent/conversations/${created.id}/messages/stream`, {
      cookie: ada,
      payload: { content: 'Time?' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const events = eventsOf(response.body);
    expect(events.map((e) => e.type)).toEqual(['message', 'message', 'step', 'message', 'text', 'text', 'message', 'done']);
    const step = events.find((e) => e.type === 'step');
    expect(step).toMatchObject({ tool: 'current_time', summary: 'Checked the time' });
    const text = events.filter((e): e is Extract<AgentStreamEvent, { type: 'text' }> => e.type === 'text');
    expect(text.map((e) => e.text).join('')).toBe('It is now.');
    const done = events.at(-1) as Extract<AgentStreamEvent, { type: 'done' }>;
    expect(done.turn.messages.at(-1)!.content).toBe('It is now.');
  });

  it('ends with an error event rather than a broken stream', async () => {
    const created = await conversation();
    script.push(fail('provider_500', 'The model’s provider is unavailable. Try again shortly.'));
    const response = await api.request('POST', `/agent/conversations/${created.id}/messages/stream`, {
      cookie: ada,
      payload: { content: 'Hello?' },
    });
    expect(response.statusCode).toBe(200);
    const events = eventsOf(response.body);
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'agent_model_failed',
      message: 'The model’s provider is unavailable. Try again shortly.',
    });
  });

  it('keeps the connection alive while the model thinks', async () => {
    const created = await conversation();
    script.push(async (request) => {
      await new Promise((r) => setTimeout(r, 120));
      return say('Done thinking.')(request);
    });
    const response = await api.request('POST', `/agent/conversations/${created.id}/messages/stream`, {
      cookie: ada,
      payload: { content: 'Think hard' },
    });
    expect(response.body).toContain(': keep-alive');
  });
});

// ────────────────────────────────────────────────────────────── attachments

describe('attachments', () => {
  beforeAll(async () => {
    ada = await signUp(api, 'Ada Lovelace', 'ada-attachments');
  });

  it('take a pasted table, as cells, and say what it holds', async () => {
    const created = await conversation();
    const table = await attachText(created.id, 'Budget', 'Item;Cost\nFlights;420\nHotel;380');
    expect(table).toMatchObject({ kind: 'table', name: 'Budget', rowCount: 3, columnCount: 2, firstRow: ['Item', 'Cost'] });
    expect(new Date(table.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
  });

  it('take a CSV file as itself', async () => {
    const created = await conversation();
    const response = await upload(created.id, 'people.csv', 'text/csv', 'Name,City\nAda,London\nGrace,New York\n');
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<AgentAttachmentView>()).toMatchObject({ kind: 'table', name: 'people.csv', rowCount: 3 });
  });

  it('keep a Word document and a Markdown file as their text', async () => {
    const created = await conversation();
    const word = await upload(
      created.id,
      'brief.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      docx(['Project brief', 'Ship the agent by Friday.']),
    );
    expect(word.statusCode, word.body).toBe(201);
    expect(word.json<AgentAttachmentView>()).toMatchObject({ kind: 'document', pages: null, rowCount: 0 });
    expect(word.json<AgentAttachmentView>().characters).toBeGreaterThan(20);
    const notes = await upload(created.id, 'notes.md', 'text/markdown', '# Notes\n\nBuy milk.');
    expect(notes.statusCode, notes.body).toBe(201);
    expect(notes.json<AgentAttachmentView>()).toMatchObject({ kind: 'document', characters: 18 });
  });

  it('refuse an empty file, an old Office format, and a file on any other route', async () => {
    const created = await conversation();
    expect((await upload(created.id, 'empty.csv', 'text/csv', '')).statusCode).toBe(422);
    const old = await upload(created.id, 'old.xls', 'application/vnd.ms-excel', 'not really');
    expect(old.statusCode).toBe(422);
    const elsewhere = await api.app.inject({
      method: 'POST',
      url: '/api/v1/agent/conversations',
      headers: { 'content-type': 'text/csv', 'x-forwarded-for': api.address },
      cookies: { mu_session: ada },
      payload: 'a,b',
    });
    expect(elsewhere.statusCode).toBe(400);
  });

  it('are named to the model, read a page at a time, and laid out from the read itself', async () => {
    const created = await conversation();
    const table = await attachText(created.id, 'Cities', 'City,Country\nLisbon,Portugal\nPorto,Portugal\nTokyo,Japan');
    script.push(call('read_table', { tableId: table.id, lines: 10 }), (request) => {
      const answer = JSON.parse(request.messages.at(-1)!.content) as { source: string };
      return call('present', { title: 'Cities', layout: 'table', source: answer.source, path: 'rows', header: true })(request);
    }, say('Here they are.'));
    const response = await api.request('POST', `/agent/conversations/${created.id}/messages`, {
      cookie: ada,
      payload: { content: 'Show my cities', attachmentIds: [table.id] },
    });
    expect(response.statusCode, response.body).toBe(201);
    const first = seen.at(-3)!;
    expect(first.system).toContain(`Cities (id ${table.id}): 4 lines × 2 columns`);
    expect(first.messages.at(-1)!.content).toContain(`[table ${table.id} “Cities”: 4 lines`);
    const result = response.json<AgentTurn>();
    const card = JSON.parse(result.messages.filter((m) => m.role === 'tool')[1]!.content) as {
      presented: boolean;
      origin: string;
      rows: string[][];
      source: { from: string };
    };
    expect(card).toMatchObject({ presented: true, origin: 'source', source: { from: 'Table “Cities”' } });
    expect(card.rows).toEqual([['Lisbon', 'Portugal'], ['Porto', 'Portugal'], ['Tokyo', 'Japan']]);
    expect((card as unknown as { columns: string[] }).columns).toEqual(['City', 'Country']);
    // The model rereads the card as "shown", not its rows again.
    expect(seen.at(-1)!.messages.at(-1)!.content).toContain('Shown to the person as a card');
  });

  it('read a document’s text for the model, as data', async () => {
    const created = await conversation();
    const notes = await upload(created.id, 'notes.txt', 'text/plain', 'Meeting moved to Thursday at 10.');
    const document = notes.json<AgentAttachmentView>();
    const result = await turn(
      created.id,
      'When is the meeting?',
      [call('read_document', { documentId: document.id }), say('Thursday at 10.')],
      { attachmentIds: [document.id] },
    );
    const read = JSON.parse(result.messages[2]!.content) as { source: string; result: { text: string } };
    expect(read.source).toMatch(/^src-[a-z0-9]{6}$/);
    expect(read.result.text).toBe('Meeting moved to Thursday at 10.');
  });

  it('are one person’s: another conversation, or another person, reads nothing of them', async () => {
    const mine = await conversation();
    const table = await attachText(mine.id, 'Secret', 'a,b\n1,2');
    const theirs = await conversation(grace);
    const result = await turn(theirs.id, 'Read it', [call('read_table', { tableId: table.id }), say('Nothing.')], {}, grace);
    expect(JSON.parse(result.messages[2]!.content)).toEqual({
      error: 'No table with that id is attached to this conversation, or it has expired.',
    });
    const present = await turn(
      theirs.id,
      'Show it',
      [call('present', { title: 'X', layout: 'table', source: 'src-abc123' }), say('Nothing.')],
      {},
      grace,
    );
    expect((JSON.parse(present.messages[2]!.content) as { error: string }).error).toContain('No read answer with source');
  });
});

// ───────────────────────────────────────────────────────── the agent’s memory

describe('the summary', () => {
  beforeAll(async () => {
    ada = await signUp(api, 'Ada Lovelace', 'ada-summary');
  });

  it('is written on /compact, read in place of what it covers, and marked on the conversation', async () => {
    const created = await conversation();
    await turn(created.id, 'My budget is 900 euros', [say('Noted: 900 euros.')]);
    script.push((request) => {
      expect(request.system).toBe(SUMMARY_INSTRUCTIONS);
      expect(request.tools).toEqual([]);
      expect(request.messages[0]!.content).toContain('Person: My budget is 900 euros');
      return say('- Budget: 900 euros')(request);
    });
    const response = await api.request('POST', `/agent/conversations/${created.id}/compact`, { cookie: ada });
    expect(response.statusCode, response.body).toBe(201);
    const compaction = response.json<AgentCompaction>();
    expect(compaction).toMatchObject({ memory: '- Budget: 900 euros', messages: 2 });
    expect(compaction.conversation.summarizedThrough).toBeTruthy();
    expect((await view(created.id)).memory).toBe('- Budget: 900 euros');

    await turn(created.id, 'What was my budget?', [say('900 euros.')]);
    const next = seen.at(-1)!;
    expect(next.system).toContain('- Budget: 900 euros');
    expect(next.messages.map((m) => m.content)).toEqual(['What was my budget?']);
  });

  it('has nothing to add when nothing has been said since', async () => {
    const created = await conversation();
    const response = await api.request('POST', `/agent/conversations/${created.id}/compact`, { cookie: ada });
    expect(response.statusCode).toBe(409);
  });

  it('is written by itself when the conversation outgrows the window', async () => {
    const created = await conversation();
    // ≈8,000 characters each against a window of ≈24,000: two turns fit, the third does not.
    const long = (n: number) => `${n} ${'x'.repeat(7990)}`;
    for (let i = 0; i < 2; i += 1) await turn(created.id, long(i), [say(`Answer ${i}.`)]);
    let summarised = false;
    script.push(
      (request) => {
        summarised = request.system === SUMMARY_INSTRUCTIONS;
        return say('- The person sent long messages')(request);
      },
      say('Still here.'),
    );
    const response = await api.request('POST', `/agent/conversations/${created.id}/messages/stream`, {
      cookie: ada,
      payload: { content: long(2) },
    });
    expect(script).toHaveLength(0);
    expect(summarised).toBe(true);
    const events = eventsOf(response.body);
    expect(events).toContainEqual({ type: 'step', tool: 'compact', summary: 'Summarised the earlier conversation' });
    const read = await view(created.id);
    expect(read.memory).toBe('- The person sent long messages');
    expect(read.conversation.summarizedThrough).toBeTruthy();
  });
});

// ──────────────────────────────────────────────────────────────── feedback

describe('feedback', () => {
  beforeAll(async () => {
    ada = await signUp(api, 'Ada Lovelace', 'ada-feedback');
  });

  it('rates an answer, and rating again changes it', async () => {
    const created = await conversation();
    const result = await turn(created.id, 'Hi', [say('Hello!')]);
    const answer = result.messages[1]!.id;
    const up = await api.request('PUT', `/agent/messages/${answer}/feedback`, { cookie: ada, payload: { rating: 1 } });
    expect(up.statusCode, up.body).toBe(200);
    const down = await api.request('PUT', `/agent/messages/${answer}/feedback`, {
      cookie: ada,
      payload: { rating: -1, note: 'Too short' },
    });
    expect(down.json()).toEqual({ messageId: answer, rating: -1, note: 'Too short' });
    expect((await view(created.id)).messages[1]!.rating).toBe(-1);
    const { rows } = await platform.query(`SELECT model, prompt_version FROM agent_feedback WHERE message_id = $1`, [answer]);
    expect(rows[0]).toMatchObject({ model: MODEL });
  });

  it('is for the agent’s answers only, and only in one’s own conversations', async () => {
    const created = await conversation();
    const result = await turn(created.id, 'Hi', [say('Hello!')]);
    const own = await api.request('PUT', `/agent/messages/${result.messages[0]!.id}/feedback`, {
      cookie: ada,
      payload: { rating: 1 },
    });
    expect(own.statusCode).toBe(422);
    const other = await api.request('PUT', `/agent/messages/${result.messages[1]!.id}/feedback`, {
      cookie: grace,
      payload: { rating: 1 },
    });
    expect(other.statusCode).toBe(404);
  });
});

// ───────────────────────────────────────────────────────── search and export

describe('search', () => {
  beforeAll(async () => {
    ada = await signUp(api, 'Ada Lovelace', 'ada-search');
  });

  it('finds words in the person’s own conversations, and nobody else’s', async () => {
    const created = await conversation();
    const word = `zanzibar${suffix}`;
    await turn(created.id, `Tell me about ${word}`, [say(`About ${word}: an island.`)]);
    const theirs = await conversation(grace);
    await turn(theirs.id, `Grace on ${word}`, [say('Mine.')], {}, grace);
    const found = (await api.request('GET', `/agent/search?q=${word}`, { cookie: ada })).json<{ items: AgentSearchHit[] }>();
    expect(found.items.map((h) => h.role).sort()).toEqual(['assistant', 'user']);
    expect(found.items.every((h) => h.conversationId === created.id)).toBe(true);
    expect((await api.request('GET', '/agent/search?q=a', { cookie: ada })).statusCode).toBe(422);
  });
});

describe('export', () => {
  beforeAll(async () => {
    ada = await signUp(api, 'Ada Lovelace', 'ada-export');
  });

  it('takes a conversation out as Markdown — what was said and the cards laid out — and audits it', async () => {
    const created = await conversation();
    const table = await attachText(created.id, 'Plan', 'Day,Place\nSat,Alfama');
    script.push(call('read_table', { tableId: table.id }), (request) => {
      const answer = JSON.parse(request.messages.at(-1)!.content) as { source: string };
      return call('present', { title: 'The plan', layout: 'table', source: answer.source, path: 'rows' })(request);
    }, say('Enjoy.'));
    await api.request('POST', `/agent/conversations/${created.id}/messages`, {
      cookie: ada,
      payload: { content: 'Lay out the plan', attachmentIds: [table.id] },
    });
    const response = await api.request('GET', `/agent/conversations/${created.id}/export`, { cookie: ada });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toMatch(/attachment; filename="Lay-out-the-plan-\d{4}-\d{2}-\d{2}\.md"/);
    expect(response.body).toContain('# Lay out the plan');
    expect(response.body).toContain('### Ada Lovelace');
    expect(response.body).toContain('#### The plan');
    expect(response.body).toContain('| Sat | Alfama |');
    const { rows } = await platform.query(
      `SELECT 1 FROM audit_log WHERE action = 'agent.conversation_exported' AND resource_id = $1`,
      [created.id],
    );
    expect(rows).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────── allowance

describe('the daily allowance', () => {
  it('refuses a turn with budget_exceeded once the day is spent — before calling the model', async () => {
    const created = await conversation(grace);
    const status = (await api.request('GET', '/agent', { cookie: grace })).json<AgentStatus>();
    const { rows } = await platform.query<{ organization_id: string; id: string }>(
      `SELECT m.organization_id, m.id FROM members m JOIN users u ON u.id = m.user_id WHERE u.email = $1`,
      [emailOf('grace')],
    );
    const member = rows[0]!;
    const client = await tenant.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [member.organization_id]);
      await client.query(
        `INSERT INTO usage_daily (organization_id, member_id, day, meter, events, quantity)
         VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date, 'agent.tokens', 1, $3)
         ON CONFLICT ON CONSTRAINT usage_daily_once DO UPDATE SET quantity = usage_daily.quantity + EXCLUDED.quantity`,
        [member.organization_id, member.id, status.allowance.tokens.ceiling],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const calls = seen.length;
    const response = await api.request('POST', `/agent/conversations/${created.id}/messages`, {
      cookie: grace,
      payload: { content: 'One more?' },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('budget_exceeded');
    expect(seen.length).toBe(calls);
    const after = (await api.request('GET', '/agent', { cookie: grace })).json<AgentStatus>();
    expect(after.allowance).toMatchObject({ usedShare: 1, messagesLeft: 0 });
  });
});

// ──────────────────────────────────────────────────────── where answers come from

describe('the model a deployment gets', () => {
  const env = (extra: Record<string, string>) =>
    loadEnv({ DATABASE_URL: 'postgres://x', DATABASE_URL_PLATFORM: 'postgres://y', SMTP_URL: 'smtp://z', ...extra });
  const logger = new AppLogger('error');

  it('is the router with a key, a labelled stand-in in development without one, and nothing in production', () => {
    expect(agentModelFor(env({ NODE_ENV: 'test', OPENROUTER_API_KEY: 'sk-or-test' }), logger).name).toBe('openrouter');
    expect(agentModelFor(env({ NODE_ENV: 'development' }), logger).name).toBe('development');
    expect(agentModelFor(env({ NODE_ENV: 'production' }), logger).name).toBe('unconfigured');
  });
});
