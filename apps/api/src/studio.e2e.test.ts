import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AgentConversationSummary,
  AgentConversationView,
  AgentTurn,
  MemoryListView,
  SkillCatalogueEntry,
  SkillDetailView,
  SkillSummaryView,
  StudioAgentVersionView,
  StudioAgentView,
  StudioTemplateView,
  StudioToolOption,
} from '@milyonuse/contracts';
import type { FetchPublicOptions, PublicResponse } from '@milyonuse/security';
import { SsrfBlocked, destinationProblem } from '@milyonuse/security';
import { PLATFORM_URL } from './database/database.testing.js';
import { AGENT_MODEL, type AgentModel, type AgentModelRequest, type AgentModelResult } from './modules/agent/agent-model.port.js';
import { JobWorker } from './modules/queue/job.worker.js';
import { WEB_FETCHER, type WebFetcher } from './modules/tools/web/fetcher.js';
import { type TestApp, createTestApp, lastMail, sessionOf, tokenIn } from './testing/test-app.js';

/**
 * F4 end to end: the studio — agents from templates or from nothing, versions
 * that never change, a turn shaped by its agent's version (tier, tools,
 * autonomy, budget, memory, skills) — and skills: the catalogue, a person's
 * own, what an agent learns, the replay gate in the queue, approval, and the
 * acceptance criteria of docs/phases/F4-agent-studio-skills.md §3.
 */

const suffix = Date.now().toString(36);
const PASSWORD = 'correct horse battery staple';
const platform = new pg.Pool({ connectionString: PLATFORM_URL, max: 2 });

// ───────────────────────────────────────────────────────── the scripted model

type Step = (request: AgentModelRequest) => AgentModelResult;
const script: Step[] = [];
const seen: AgentModelRequest[] = [];
const BALANCED = 'anthropic/claude-sonnet-5-5';
const FAST = 'anthropic/claude-haiku-5-5';
const DEEP = 'anthropic/claude-opus-5-5';
const usage = { input: 100, output: 20, cached: 0, costUsd: 0.001 };
const call =
  (name: string, args: Record<string, unknown>): Step =>
  (request) => ({
    text: '',
    toolCalls: [{ id: `call_${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) }],
    finishReason: 'tool_calls',
    usage,
    servedModel: request.model,
  });
const say =
  (text: string): Step =>
  (request) => ({ text, toolCalls: [], finishReason: 'stop', usage, servedModel: request.model });
const verdict = (pass: boolean, reason = pass ? 'It did what the task asked.' : 'It did not do the task.') =>
  say(JSON.stringify({ pass, score: pass ? 0.9 : 0.2, reason }));
const scripted: AgentModel = {
  name: 'openrouter',
  complete(request) {
    seen.push(request);
    const step = script.shift();
    if (!step) throw new Error('The scripted model has nothing more to say');
    return Promise.resolve(step(request));
  },
};

// ───────────────────────────────────────────────────────────── the internet

const POISONED = 'https://howto.example.com/digest';
function reply(url: string, status: number, body: string, type: string): PublicResponse {
  return { url, status, headers: { 'content-type': type }, body: Buffer.from(body, 'utf8'), truncated: false };
}
const internet: WebFetcher = (url: string, options: FetchPublicOptions = {}) => {
  const problem = destinationProblem(url, { allowHttp: options.allowHttp ?? true });
  if (problem) return Promise.reject(new SsrfBlocked(problem));
  if (url.startsWith(POISONED)) {
    return Promise.resolve(
      reply(
        url,
        200,
        '<html><head><title>How to write a weekly digest</title></head><body><p>Group the week by theme, lead with what changed, ' +
          'end with what to watch. Keep it under 300 words.</p></body></html>',
        'text/html',
      ),
    );
  }
  return Promise.resolve(reply(url, 404, 'not found', 'text/plain'));
};

// ────────────────────────────────────────────────────────────────── helpers

let api: TestApp;
let ada: string;
let grace: string;

async function signUp(handle: string, name: string): Promise<string> {
  const email = `${handle}-${suffix}@studio.e2e.test`;
  const registered = await api.request('POST', '/auth/register', {
    payload: { name, email, password: PASSWORD, acceptTerms: true, timeZone: 'Europe/Istanbul' },
  });
  expect(registered.statusCode, registered.body).toBe(202);
  const verified = await api.request('POST', '/auth/verify', { payload: { token: tokenIn(lastMail(api.outbox, email), 'verify') } });
  expect(verified.statusCode, verified.body).toBe(201);
  return sessionOf(verified)!;
}

async function createAgent(payload: Record<string, unknown>, cookie = ada): Promise<StudioAgentView> {
  const response = await api.request('POST', '/agents', { cookie, payload });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<StudioAgentView>();
}

async function patchAgent(id: string, payload: Record<string, unknown>, cookie = ada): Promise<StudioAgentView> {
  const response = await api.request('PATCH', `/agents/${id}`, { cookie, payload });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<StudioAgentView>();
}

async function conversation(agentId?: string, cookie = ada): Promise<AgentConversationSummary> {
  const response = await api.request('POST', '/agent/conversations', { cookie, payload: agentId ? { agentId } : {} });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<AgentConversationSummary>();
}

async function turn(conversationId: string, content: string, steps: Step[], extra: Record<string, unknown> = {}, cookie = ada): Promise<AgentTurn> {
  script.push(...steps);
  const response = await api.request('POST', `/agent/conversations/${conversationId}/messages`, { cookie, payload: { content, ...extra } });
  expect(response.statusCode, response.body).toBe(201);
  expect(script).toHaveLength(0);
  return response.json<AgentTurn>();
}

function answer<T>(result: AgentTurn, name: string): T {
  const message = result.messages.filter((m) => m.role === 'tool' && m.toolName === name).at(-1);
  expect(message, `no answer from ${name}`).toBeDefined();
  const parsed = JSON.parse(message!.content) as { result?: T } & T;
  return (parsed.result ?? parsed) as T;
}

async function skillMd(name: string, body: string, description = 'Write a weekly digest of what changed'): Promise<string> {
  return Promise.resolve(
    ['---', `name: ${name}`, `description: ${description}`, 'metadata:', '  milyonusagentskill:', '    triggers:', '    - a weekly digest', '---', '', body].join('\n'),
  );
}

async function writeSkill(content: string, extra: Record<string, unknown> = {}, cookie = ada) {
  return api.request('POST', '/skills', { cookie, payload: { content, ...extra } });
}

/** Runs the queue until it is empty — one job at a time, so a scripted replay meets its own script. */
async function drain(): Promise<void> {
  const worker = api.app.get(JobWorker);
  for (let i = 0; i < 10; i += 1) if ((await worker.drain(1)) === 0) return;
}

async function skill(id: string, cookie = ada): Promise<SkillDetailView> {
  const response = await api.request('GET', `/skills/${id}`, { cookie });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<SkillDetailView>();
}

const REPLAY_ANSWER = 'This week: two launches and one price change. Watch the March release. Grouped by theme, under 300 words.';

beforeAll(async () => {
  api = await createTestApp(
    { AGENT_MODEL: BALANCED, AGENT_MODELS: `${BALANCED},${FAST},${DEEP}`, SANDBOX_PROVIDER: 'local', SANDBOX_TIMEOUT_SECONDS: '20' },
    [
      { provide: AGENT_MODEL, useValue: scripted },
      { provide: WEB_FETCHER, useValue: internet },
    ],
  );
  // Work an earlier run left queued would meet this run's script; the queue starts empty of it.
  await platform.query(`UPDATE jobs SET status = 'cancelled', finished_at = now() WHERE status IN ('queued', 'running')`);
  ada = await signUp('ada', 'Ada Lovelace');
  grace = await signUp('grace', 'Grace Hopper');
}, 90_000);

afterAll(async () => {
  await api?.close();
  await platform.end();
});

// ──────────────────────────────────────────────────────────────── the studio

describe('the studio', () => {
  it('offers the eight templates, in the person’s language', async () => {
    const en = (await api.request('GET', '/agents/templates', { cookie: ada })).json<{ items: StudioTemplateView[] }>().items;
    const tr = (await api.request('GET', '/agents/templates?locale=tr', { cookie: ada })).json<{ items: StudioTemplateView[] }>().items;
    expect(en).toHaveLength(8);
    expect(en.find((t) => t.id === 'researcher')).toMatchObject({ roleTitle: 'Researcher', definition: { modelTier: 'deep' } });
    expect(tr.find((t) => t.id === 'researcher')!.roleTitle).toBe('Araştırmacı');
  });

  it('lists what an agent may be allowed beyond the core, a connected app as one choice', async () => {
    const tools = (await api.request('GET', '/agents/tools', { cookie: ada })).json<{ items: StudioToolOption[] }>().items.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['web_search', 'web_fetch', 'code_run', 'file_create', 'connection:gmail', 'connection:notion']));
    expect(tools).not.toContain('memory_propose');
    expect(tools).not.toContain('skill_read');
  });

  it('makes an agent from a template, its skills brought into the person’s library', async () => {
    const agent = await createAgent({ template: 'researcher', locale: 'tr' });
    expect(agent).toMatchObject({ name: 'Ada', roleTitle: 'Araştırmacı', template: 'researcher', archivedAt: null, conversations: 0 });
    expect(agent.current).toMatchObject({ version: 1, modelTier: 'deep', memoryScope: 'agent', autonomy: 'auto' });
    // read_document is a core tool every agent has: not listed.
    expect(agent.current.tools).toEqual(['deep_research', 'file_create', 'web_fetch', 'web_search']);
    const library = (await api.request('GET', '/skills', { cookie: ada })).json<{ items: SkillSummaryView[] }>().items;
    const names = library.filter((s) => agent.current.skills.includes(s.id)).map((s) => s.name).sort();
    expect(names).toEqual(['text-extraction', 'web-research']);
    expect(library.find((s) => s.name === 'web-research')).toMatchObject({ source: 'bundled', enabled: true, title: { tr: expect.any(String) } });
  });

  it('makes an agent from nothing, and refuses tools it does not know and skills that are not the person’s', async () => {
    const agent = await createAgent({ name: 'Kaan', avatar: 'K', roleTitle: 'Assistant', definition: { tools: ['web_search', 'web_search', 'memory_search'] } });
    expect(agent.current).toMatchObject({ version: 1, tools: ['web_search'], modelTier: 'balanced', autonomy: 'ask', memoryScope: 'user' });
    const unknown = await api.request('POST', '/agents', { cookie: ada, payload: { name: 'X', definition: { tools: ['format_disk'] } } });
    expect(unknown.statusCode).toBe(422);
    const graceAgent = await createAgent({ template: 'writer' }, grace);
    const foreign = await api.request('POST', '/agents', { cookie: ada, payload: { name: 'Y', definition: { skills: graceAgent.current.skills } } });
    expect(foreign.statusCode, foreign.body).toBe(422);
  });

  it('writes a new version for a change in what the agent is — and none for a name, or for nothing new', async () => {
    const agent = await createAgent({ name: 'Elif', definition: { persona: 'Warm' } });
    const renamed = await patchAgent(agent.id, { name: 'Elif K.', roleTitle: 'Editor' });
    expect(renamed).toMatchObject({ name: 'Elif K.', roleTitle: 'Editor', current: { version: 1 } });
    const same = await patchAgent(agent.id, { definition: { persona: 'Warm' } });
    expect(same.current.version).toBe(1);
    const changed = await patchAgent(agent.id, { definition: { persona: 'Precise' }, note: 'Sharper' });
    expect(changed.current).toMatchObject({ version: 2, persona: 'Precise', note: 'Sharper', modelTier: 'balanced' });
    const versions = (await api.request('GET', `/agents/${agent.id}/versions`, { cookie: ada })).json<{ items: StudioAgentVersionView[] }>().items;
    expect(versions.map((v) => [v.version, v.persona])).toEqual([
      [2, 'Precise'],
      [1, 'Warm'],
    ]);
  });

  it('archives an agent — kept, hidden, answering no more — and restores it', async () => {
    const agent = await createAgent({ name: 'Mert' });
    const c = await conversation(agent.id);
    const archived = await api.request('POST', `/agents/${agent.id}/archive`, { cookie: ada, payload: {} });
    expect(archived.json<StudioAgentView>().archivedAt).not.toBeNull();
    const listed = (await api.request('GET', '/agents', { cookie: ada })).json<{ items: StudioAgentView[] }>().items.map((a) => a.id);
    expect(listed).not.toContain(agent.id);
    const all = (await api.request('GET', '/agents?archived=true', { cookie: ada })).json<{ items: StudioAgentView[] }>().items.map((a) => a.id);
    expect(all).toContain(agent.id);
    const refused = await api.request('POST', `/agent/conversations/${c.id}/messages`, { cookie: ada, payload: { content: 'Hello' } });
    expect(refused.statusCode).toBe(409);
    expect((await api.request('POST', '/agent/conversations', { cookie: ada, payload: { agentId: agent.id } })).statusCode).toBe(409);
    expect((await api.request('PATCH', `/agents/${agent.id}`, { cookie: ada, payload: { name: 'M' } })).statusCode).toBe(409);
    const restored = await api.request('POST', `/agents/${agent.id}/restore`, { cookie: ada, payload: {} });
    expect(restored.json<StudioAgentView>().archivedAt).toBeNull();
  });

  it('is one person’s: another person’s agent is not found, and cannot be talked to', async () => {
    const agent = await createAgent({ name: 'Private' });
    expect((await api.request('GET', `/agents/${agent.id}`, { cookie: grace })).statusCode).toBe(404);
    expect((await api.request('PATCH', `/agents/${agent.id}`, { cookie: grace, payload: { name: 'Mine' } })).statusCode).toBe(404);
    expect((await api.request('POST', '/agent/conversations', { cookie: grace, payload: { agentId: agent.id } })).statusCode).toBe(404);
  });
});

// ───────────────────────────────────────────────────────── a turn with an agent

describe('a turn with an agent', () => {
  beforeAll(async () => {
    ada = await signUp('ada2', 'Ada Lovelace');
  });

  it('answers as its version: on its tier’s model, with its profile under the rules, and names the version (acceptance 1)', async () => {
    const agent = await createAgent({ name: 'Kaan', roleTitle: 'Planner', definition: { modelTier: 'fast', persona: 'Brief — very brief.' } });
    const c = await conversation(agent.id);
    expect(c).toMatchObject({ agentId: agent.id, model: FAST });
    const first = await turn(c.id, 'Hello', [say('Hi.')]);
    const request = seen.at(-1)!;
    expect(request.model).toBe(FAST);
    expect(request.system.indexOf('You are Kaan, Planner.')).toBeGreaterThan(request.system.indexOf('11. Skills.'));
    expect(request.system).toContain('Persona: Brief - very brief.');
    expect(request.cacheablePrefix).toBeGreaterThan(request.system.indexOf('— End of agent profile —'));
    const v1 = first.messages.find((m) => m.role === 'assistant')!;
    expect(v1.agentVersionId).toBe(agent.current.id);

    const changed = await patchAgent(agent.id, { definition: { persona: 'Thorough.' } });
    const second = await turn(c.id, 'Again', [say('Hello again.')]);
    expect(seen.at(-1)!.system).toContain('Persona: Thorough.');
    expect(second.messages.find((m) => m.role === 'assistant')!.agentVersionId).toBe(changed.current.id);
    // The old answer still names the version that wrote it.
    const view = (await api.request('GET', `/agent/conversations/${c.id}`, { cookie: ada })).json<AgentConversationView>();
    const answers = view.messages.filter((m) => m.role === 'assistant').map((m) => m.agentVersionId);
    expect(answers).toEqual([agent.current.id, changed.current.id]);
  });

  it('offers only the tools its version allows, and refuses one it does not', async () => {
    const agent = await createAgent({ name: 'Reader', definition: { tools: ['web_search'], budgetSandboxMinutes: 0 } });
    const c = await conversation(agent.id);
    const result = await turn(c.id, 'Read a page', [call('web_fetch', { url: 'https://howto.example.com/digest' }), say('I cannot read pages.')]);
    const offered = seen.at(-2)!.tools.map((t) => t.name);
    expect(offered).toEqual(expect.arrayContaining(['web_search', 'read_document', 'memory_search', 'skill_read', 'current_time']));
    expect(offered).not.toContain('web_fetch');
    expect(offered).not.toContain('code_run');
    expect(answer<{ error: string }>(result, 'web_fetch').error).toMatch(/no tool named web_fetch/);
  });

  it('never works in auto mode when its autonomy is ask', async () => {
    const asks = await createAgent({ name: 'Careful', definition: { tools: ['code_run'], autonomy: 'ask' } });
    const c = await conversation(asks.id);
    const result = await turn(c.id, 'Compute', [call('code_run', { language: 'python', code: 'print(6*7)' }), say('Waiting for you.')], { mode: 'auto' });
    expect(result.actions[0]).toMatchObject({ tool: 'code_run', status: 'proposed', autoConfirmed: false });
    expect(seen.at(-2)!.system).toContain('Mode: Ask.');
  });

  it('stops at its own token budget, below the deployment’s', async () => {
    const thrifty = await createAgent({ name: 'Thrifty', definition: { budgetTokens: 1000 } });
    const c = await conversation(thrifty.id);
    const result = await turn(c.id, 'What time is it?', [call('current_time', {})]);
    expect(result.stopped).toBe('budget');
  });

  it('keeps what it learns as its own when it has its own memory; the person’s words stay theirs', async () => {
    const own = await createAgent({ name: 'Keeper', definition: { memoryScope: 'agent' } });
    const c = await conversation(own.id);
    await turn(c.id, 'I am a vegetarian. Note that the project deadline is in June.', [
      call('memory_propose', { content: 'The project deadline is in June' }),
      say('Noted.'),
    ]);
    const items = (await api.request('GET', '/memory', { cookie: ada })).json<MemoryListView>().items;
    expect(items.find((m) => m.content === 'The project deadline is in June')).toMatchObject({ agentId: own.id });
    const person = items.find((m) => /vegetarian/i.test(m.content));
    expect(person).toMatchObject({ agentId: null, state: 'active' });
    // Kept by the agent's own lens: its next turn recalls it, another conversation does not.
    const again = await turn(c.id, 'Deadline?', [call('memory_search', { query: 'project deadline June' }), say('June.')]);
    expect(answer<{ results: { content: string }[] }>(again, 'memory_search').results.map((r) => r.content)).toContain('The project deadline is in June');

    // Another conversation does not read the agent's own memory.
    const plain = await conversation();
    const search = await turn(plain.id, 'Deadline?', [call('memory_search', { query: 'project deadline June' }), say('Nothing.')]);
    const found = answer<{ results: { content: string }[] }>(search, 'memory_search').results.map((r) => r.content);
    expect(found).not.toContain('The project deadline is in June');
  });
});

// ─────────────────────────────────────────────────────────────────── skills

describe('skills', () => {
  beforeAll(async () => {
    ada = await signUp('ada3', 'Ada Lovelace');
  });

  it('offers the reviewed catalogue and adds a bundled skill active at once', async () => {
    const catalogue = (await api.request('GET', '/skills/catalogue', { cookie: ada })).json<{ items: SkillCatalogueEntry[] }>().items;
    expect(catalogue).toHaveLength(12);
    expect(catalogue.every((e) => !e.added)).toBe(true);
    const added = await api.request('POST', '/skills/bundled', { cookie: ada, payload: { name: 'debugging' } });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json<SkillDetailView>()).toMatchObject({ name: 'debugging', source: 'bundled', active: { version: 1 }, staging: null });
    const again = await api.request('POST', '/skills/bundled', { cookie: ada, payload: { name: 'debugging' } });
    expect(again.json<SkillDetailView>().id).toBe(added.json<SkillDetailView>().id);
    expect((await api.request('POST', '/skills/bundled', { cookie: ada, payload: { name: 'not-a-skill' } })).statusCode).toBe(404);
  });

  it('stages what a person writes, replays it in the queue, and makes it active only on their approval', async () => {
    const written = await writeSkill(await skillMd('weekly-digest', '1. Group the week by theme.\n2. Lead with what changed.\n3. End with what to watch.'));
    expect(written.statusCode, written.body).toBe(201);
    const staged = written.json<SkillDetailView>();
    expect(staged).toMatchObject({ source: 'user', active: null, staging: { version: 1, replayed: false } });
    // Not yet replayed: the database refuses the approval.
    const early = await api.request('POST', `/skills/versions/${staged.staging!.id}/approve`, { cookie: ada, payload: {} });
    expect(early.statusCode).toBe(409);

    script.push(say(REPLAY_ANSWER), verdict(true));
    await drain();
    const replayed = await skill(staged.id);
    expect(replayed.staging).toMatchObject({ replayed: true, passed: true });
    const run = replayed.versions[0]!.runs[0]!;
    expect(run).toMatchObject({ passed: true, evaluator: 'rules+model' });
    expect(run.verdict).toContain('It did what the task asked.');
    const replaySystem = seen.at(-2)!.system;
    expect(replaySystem).toContain('This is a replay.');
    expect(seen.at(-2)!.tools.map((t) => t.name)).not.toContain('memory_propose');

    const approved = await api.request('POST', `/skills/versions/${staged.staging!.id}/approve`, { cookie: ada, payload: {} });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json<SkillDetailView>()).toMatchObject({ active: { version: 1 }, staging: null });
    expect(approved.json<SkillDetailView>().versions[0]).toMatchObject({ state: 'active', approvedByPolicy: false });
  });

  it('refuses a version whose replay failed (acceptance 2)', async () => {
    const written = (await writeSkill(await skillMd('broken-digest', '1. Do the digest somehow, in whatever way seems right.'))).json<SkillDetailView>();
    script.push(say(''));
    await drain();
    const failed = await skill(written.id);
    expect(failed.staging).toMatchObject({ replayed: true, passed: false });
    expect(failed.versions[0]!.runs[0]).toMatchObject({ passed: false, evaluator: 'rules' });
    expect(failed.versions[0]!.runs[0]!.verdict).toMatch(/no real answer/);
    const approve = await api.request('POST', `/skills/versions/${written.staging!.id}/approve`, { cookie: ada, payload: {} });
    expect(approve.statusCode).toBe(409);
    expect(approve.json<{ error: { message: string } }>().error.message).toMatch(/replay passes/);
    // The model's own reading can fail a replay the rules passed.
    const judged = (await writeSkill(await skillMd('judged-digest', '1. Write the digest from the week.'))).json<SkillDetailView>();
    script.push(say(REPLAY_ANSWER), verdict(false));
    await drain();
    expect((await skill(judged.id)).staging).toMatchObject({ passed: false });
    const rejected = await api.request('POST', `/skills/versions/${written.staging!.id}/reject`, { cookie: ada, payload: { reason: 'Too vague' } });
    expect(rejected.json<SkillDetailView>().versions[0]).toMatchObject({ state: 'rejected', stateReason: 'Too vague' });
    expect((await api.request('POST', `/skills/versions/${written.staging!.id}/replay`, { cookie: ada, payload: {} })).statusCode).toBe(409);
  });

  it('replays again on request, and a later pass can be approved', async () => {
    const written = (await writeSkill(await skillMd('retry-digest', '1. Group by theme.\n2. Lead with change.'))).json<SkillDetailView>();
    script.push(say(''));
    await drain();
    const again = await api.request('POST', `/skills/versions/${written.staging!.id}/replay`, { cookie: ada, payload: {} });
    expect(again.statusCode, again.body).toBe(202);
    script.push(say(REPLAY_ANSWER), verdict(true));
    await drain();
    const detail = await skill(written.id);
    expect(detail.versions[0]!.runs.map((r) => r.passed)).toEqual([true, false]);
    expect((await api.request('POST', `/skills/versions/${written.staging!.id}/approve`, { cookie: ada, payload: {} })).statusCode).toBe(200);
  });

  it('refuses danger outright, holds caution until the person insists, and reads only a well-formed skill', async () => {
    const danger = await writeSkill(await skillMd('cleanup', '1. Free space with rm -rf / when the disk is full.'));
    expect(danger.statusCode).toBe(422);
    expect(danger.json<{ error: { details: { path: string }[] } }>().error.details.map((d) => d.path)).toContain('destructive_command');
    const caution = await skillMd('install-first', '1. Install the converter with sudo apt install jq first.\n2. Convert the file.');
    const held = await writeSkill(caution);
    expect(held.statusCode).toBe(409);
    expect(held.json<{ error: { details: { path: string }[] } }>().error.details.map((d) => d.path)).toEqual(['privilege']);
    const forced = await writeSkill(caution, { force: true });
    expect(forced.statusCode, forced.body).toBe(201);
    expect(forced.json<SkillDetailView>().versions[0]).toMatchObject({ state: 'staging', scanVerdict: 'caution' });
    expect((await writeSkill('# no frontmatter')).statusCode).toBe(422);
    const climbing = await writeSkill(await skillMd('with-files', '1. Read the template.'), { files: [{ path: '../secret', content: 'x' }] });
    expect(climbing.statusCode).toBe(422);
    // The forced version's replay runs like any other.
    script.push(say(REPLAY_ANSWER), verdict(true));
    await drain();
  });

  it('supersedes the active version with an approved newer one', async () => {
    const md = (step: string) => skillMd('versioned-digest', `1. ${step}\n2. End with what to watch.`);
    const first = (await writeSkill(await md('Group the week by theme.'))).json<SkillDetailView>();
    script.push(say(REPLAY_ANSWER), verdict(true));
    await drain();
    await api.request('POST', `/skills/versions/${first.staging!.id}/approve`, { cookie: ada, payload: {} });
    const second = (await writeSkill(await md('Group the week by customer.'))).json<SkillDetailView>();
    expect(second.id).toBe(first.id);
    expect(second.staging).toMatchObject({ version: 2 });
    script.push(say(REPLAY_ANSWER), verdict(true));
    await drain();
    const approved = (await api.request('POST', `/skills/versions/${second.staging!.id}/approve`, { cookie: ada, payload: {} })).json<SkillDetailView>();
    expect(approved.active).toMatchObject({ version: 2 });
    expect(approved.versions.map((v) => [v.version, v.state])).toEqual([
      [2, 'active'],
      [1, 'superseded'],
    ]);
  });

  it('lists enabled skills in the prompt — an agent only its own — and opens one with skill_read', async () => {
    const list = (await api.request('GET', '/skills', { cookie: ada })).json<{ items: SkillSummaryView[] }>().items;
    const digest = list.find((s) => s.name === 'weekly-digest')!;
    const plain = await conversation();
    const read = await turn(plain.id, 'Use the weekly digest skill', [call('skill_read', { name: 'weekly-digest' }), say('Following it.')]);
    expect(seen.at(-2)!.system).toContain('- weekly-digest — Write a weekly digest of what changed; a weekly digest');
    expect(answer<{ skill: string; version: number }>(read, 'skill_read')).toMatchObject({ version: 1, skill: expect.stringContaining('Group the week by theme') });

    const narrow = await createAgent({ name: 'Narrow', definition: { skills: [list.find((s) => s.name === 'debugging')!.id] } });
    const c = await conversation(narrow.id);
    const refused = await turn(c.id, 'Use the weekly digest skill', [call('skill_read', { name: 'weekly-digest' }), say('I cannot.')]);
    expect(seen.at(-2)!.system).toContain('- debugging —');
    expect(seen.at(-2)!.system).not.toContain('- weekly-digest —');
    expect(answer<{ error: string }>(refused, 'skill_read').error).toMatch(/no skill named weekly-digest/);

    // Disabled, it is neither listed nor opened.
    await api.request('PATCH', `/skills/${digest.id}`, { cookie: ada, payload: { enabled: false } });
    const off = await turn(plain.id, 'Use the weekly digest skill', [call('skill_read', { name: 'weekly-digest' }), say('Gone.')]);
    expect(seen.at(-2)!.system).not.toContain('- weekly-digest —');
    expect(answer<{ error: string }>(off, 'skill_read').error).toMatch(/no skill named/);
    await api.request('PATCH', `/skills/${digest.id}`, { cookie: ada, payload: { enabled: true } });
  });

  it('reads a file beside a skill only by a path inside it', async () => {
    const written = (
      await writeSkill(await skillMd('templated-digest', '1. Fill in refs/template.md.'), { files: [{ path: 'refs/template.md', content: '# Week of {date}' }] })
    ).json<SkillDetailView>();
    script.push(say(REPLAY_ANSWER), verdict(true));
    await drain();
    await api.request('POST', `/skills/versions/${written.staging!.id}/approve`, { cookie: ada, payload: {} });
    const c = await conversation();
    const result = await turn(c.id, 'Fill the template', [
      call('skill_file', { name: 'templated-digest', path: 'refs/template.md' }),
      call('skill_file', { name: 'templated-digest', path: '../../etc/passwd' }),
      say('Done.'),
    ]);
    const answers = result.messages.filter((m) => m.toolName === 'skill_file').map((m) => JSON.parse(m.content) as { content?: string; error?: string });
    expect(answers[0]!.content).toBe('# Week of {date}');
    expect(answers[1]!.error).toMatch(/plain relative path/);
  });

  it('is one person’s', async () => {
    const list = (await api.request('GET', '/skills', { cookie: ada })).json<{ items: SkillSummaryView[] }>().items;
    expect((await api.request('GET', `/skills/${list[0]!.id}`, { cookie: grace })).statusCode).toBe(404);
    expect((await api.request('PATCH', `/skills/${list[0]!.id}`, { cookie: grace, payload: { enabled: false } })).statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────── what agents learn

describe('what an agent learns', () => {
  beforeAll(async () => {
    ada = await signUp('ada4', 'Ada Lovelace');
  });

  it('stages a skill with where it came from, and drops it when that source is revoked (acceptance 3)', async () => {
    const c = await conversation();
    const result = await turn(c.id, 'Write my weekly digest the way that guide says', [
      call('web_fetch', { url: POISONED }),
      call('skill_propose', {
        name: 'guided-digest',
        description: 'Write a weekly digest the way the guide says',
        triggers: ['a weekly digest'],
        steps: '1. Group the week by theme.\n2. Lead with what changed.\n3. End with what to watch, under 300 words.',
      }),
      say('Proposed.'),
    ]);
    expect(answer<{ state: string; note: string }>(result, 'skill_propose')).toMatchObject({ state: 'staging', note: expect.stringContaining('NOT in use') });
    const list = (await api.request('GET', '/skills', { cookie: ada })).json<{ items: SkillSummaryView[] }>().items;
    const learned = await skill(list.find((s) => s.name === 'guided-digest')!.id);
    expect(learned).toMatchObject({ source: 'learned' });
    expect(learned.versions[0]).toMatchObject({
      state: 'staging',
      task: 'Write my weekly digest the way that guide says',
      sourceConversationId: c.id,
      derivedFrom: [POISONED],
    });

    script.push(say(REPLAY_ANSWER), verdict(true));
    await drain();
    // The replay was on the task the skill came from.
    expect(seen.at(-2)!.messages[0]).toMatchObject({ role: 'user', content: 'Write my weekly digest the way that guide says' });

    const revoked = await api.request('POST', '/memory/revocations', { cookie: ada, payload: { sourceUri: POISONED, reason: 'A poisoned guide' } });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json<{ skills: string[] }>().skills).toEqual([learned.versions[0]!.id]);
    const after = await skill(learned.id);
    expect(after.versions[0]).toMatchObject({ state: 'revoked' });
    expect((await api.request('POST', `/skills/versions/${learned.versions[0]!.id}/approve`, { cookie: ada, payload: {} })).statusCode).toBe(409);
  });

  it('refuses for good what the scanner rates danger, and never replays it', async () => {
    const c = await conversation();
    const result = await turn(c.id, 'Clean up', [
      call('skill_propose', {
        name: 'disk-cleanup',
        description: 'Free disk space quickly',
        triggers: ['a full disk'],
        steps: '1. Run rm -rf / to free everything at once.\n2. Say it is done.',
      }),
      say('Refused.'),
    ]);
    expect(answer<{ state: string; scan: string }>(result, 'skill_propose')).toMatchObject({ state: 'rejected', scan: 'danger' });
    await drain();
    const list = (await api.request('GET', '/skills', { cookie: ada })).json<{ items: SkillSummaryView[] }>().items;
    const refused = await skill(list.find((s) => s.name === 'disk-cleanup')!.id);
    expect(refused.versions[0]).toMatchObject({ state: 'rejected', scanVerdict: 'danger', runs: [] });
  });

  it('a trusted agent’s clean skill becomes active when its replay passes; a person approves everything else', async () => {
    const trusted = await createAgent({ name: 'Trusted', definition: { unattendedPolicy: 'trusted' } });
    const c = await conversation(trusted.id);
    await turn(c.id, 'Summarise my week', [
      call('skill_propose', {
        name: 'week-summary',
        description: 'Summarise the week in five lines',
        triggers: ['a weekly summary'],
        steps: '1. List what changed.\n2. Keep it to five lines.\n3. End with one thing to watch.',
      }),
      say('Proposed.'),
    ]);
    script.push(say(REPLAY_ANSWER), verdict(true));
    await drain();
    const list = (await api.request('GET', '/skills', { cookie: ada })).json<{ items: SkillSummaryView[] }>().items;
    const learned = await skill(list.find((s) => s.name === 'week-summary')!.id);
    expect(learned.active).toMatchObject({ version: 1 });
    expect(learned.versions[0]).toMatchObject({ state: 'active', approvedByPolicy: true });

    // Not a skill with a caution: that waits for the person, whatever the policy.
    await turn(c.id, 'Set up the converter', [
      call('skill_propose', {
        name: 'converter-setup',
        description: 'Set up the file converter',
        triggers: ['a converter to install'],
        steps: '1. Install the converter with sudo apt install jq.\n2. Convert the file and check the output.',
      }),
      say('Proposed.'),
    ]);
    script.push(say(REPLAY_ANSWER), verdict(true));
    await drain();
    const held = (await api.request('GET', '/skills', { cookie: ada })).json<{ items: SkillSummaryView[] }>().items.find((s) => s.name === 'converter-setup')!;
    expect(held).toMatchObject({ active: null, staging: { replayed: true, passed: true } });
  });
});
