import type {
  AgentModel,
  AgentModelMessage,
  AgentModelRequest,
  AgentModelResult,
  AgentToolCall,
} from './agent-model.port.js';
import { isSourceAnswer } from './answers.js';
import { SUMMARY_INSTRUCTIONS } from './context.js';

const NOTE = '(Development stand-in — no language model is connected; set OPENROUTER_API_KEY for the real agent.)';
const ULID = '[0-7][0-9A-HJKMNP-TV-Z]{25}';

/**
 * A local stand-in for the agent's model (ported from App-Milyonus
 * `modules/agent/development.model.ts`, with general-purpose rules).
 *
 * It exists so the whole path — the conversation, the stream, the tools, a
 * card, the summary — runs on a developer machine without a model router's
 * key. Everything around the judgement is real; the judgement is a handful of
 * rules, and every answer says so:
 *
 *   an attached table             → read_table, then present it as a table
 *   an attached document          → read_document, then its opening words
 *   "remember …" / "hatırla …"    → memory_propose
 *   "what do you remember about…" → memory_search
 *   "time" / "saat"               → current_time
 *   "run python: …" / "run node: …" → code_run (a card in ask mode)
 *   "make a csv/xlsx/md file …"   → file_create
 *   "read https://…"              → web_fetch
 *   "search the web for …"        → web_search
 *   "email a@b.c: subject | body" → email_send (always a card)
 *   "use the <name> skill"         → skill_read
 *   "save this as a skill called <name>: steps" → skill_propose (staged, replayed)
 *   anything else                 → says what it understands
 *
 * Refuses to construct in production: an agent that pattern-matches must
 * never be mistaken for one that understands.
 */
export class DevelopmentAgentModel implements AgentModel {
  readonly name = 'development' as const;
  private calls = 0;

  constructor(nodeEnv: string) {
    if (nodeEnv === 'production') {
      throw new Error('DevelopmentAgentModel must never run in production. Set OPENROUTER_API_KEY.');
    }
  }

  complete(request: AgentModelRequest): Promise<AgentModelResult> {
    const result = this.decide(request);
    // Streamed like the live model, word by word, so the page reads the same way here.
    if (request.onText && result.text) for (const piece of result.text.match(/\S+\s*/g) ?? []) request.onText(piece);
    return Promise.resolve(result);
  }

  private decide(request: AgentModelRequest): AgentModelResult {
    this.calls += 1;
    const last = request.messages.at(-1);
    if (!last) return this.answer(`${NOTE}\n\nNothing to answer.`);
    // The conversation's summary: the person's own words, listed.
    if (request.system === SUMMARY_INSTRUCTIONS) return this.answer(remembered(last.content));
    // A team run (F5): each role by the engine's own markers.
    const team = this.teamRole(request);
    if (team) return team;
    if (last.role === 'tool') return this.afterTools(request.messages);
    if (last.role !== 'user') return this.answer(`${NOTE}\n\nNothing to answer.`);

    const text = last.content;
    const lower = text.toLocaleLowerCase('tr');
    const table = new RegExp(`\\[table (${ULID})`).exec(text)?.[1];
    if (table) return this.call('read_table', { tableId: table, lines: 50 });
    const document = new RegExp(`\\[document (${ULID})`).exec(text)?.[1];
    if (document) return this.call('read_document', { documentId: document });
    const remember = /^(?:please\s+)?(?:remember(?: that)?|hatırla(?::)?|unutma(?::)?)\s+(.{3,})$/iu.exec(text.trim());
    if (remember) return this.call('memory_propose', { content: remember[1]!.replace(/[.!]+$/, '') });
    const recall = /(?:what do you (?:remember|know) about|ne hatırlıyorsun|hakkında ne biliyorsun)\s*(.*)$/iu.exec(text.trim());
    if (recall) return this.call('memory_search', { query: recall[1]?.replace(/[?.!]+$/, '').trim() || text });
    const code = /^run (python|node)\s*:\s*([\s\S]+)$/i.exec(text.trim());
    if (code) return this.call('code_run', { language: code[1]!.toLowerCase(), code: code[2]!, purpose: 'what you asked' });
    const file = /\bmake an? (csv|xlsx|md|txt|docx) file\b(?: called ([\w.-]+))?/i.exec(text);
    if (file) {
      const format = file[1]!.toLowerCase();
      const name = file[2] ?? 'example';
      return format === 'csv' || format === 'xlsx'
        ? this.call('file_create', { name, format, rows: [['Item', 'Count'], ['Apples', '3'], ['Pears', '5']] })
        : this.call('file_create', { name, format, content: `# ${name}\n\n- One\n- Two\n` });
    }
    const url = /\bread (https?:\/\/\S+)/i.exec(text);
    if (url) return this.call('web_fetch', { url: url[1]!.replace(/[).,]+$/, '') });
    const search = /\bsearch the web for (.{2,})$/i.exec(text.trim());
    if (search) return this.call('web_search', { query: search[1]!.replace(/[?.!]+$/, '') });
    const mail = /^email ([^\s:]+@[^\s:]+)\s*:\s*([^|]+)\|([\s\S]+)$/i.exec(text.trim());
    if (mail) return this.call('email_send', { to: [mail[1]!], subject: mail[2]!.trim(), body: mail[3]!.trim() });
    const useSkill = /\buse the ([a-z0-9][a-z0-9-]{1,63}) skill\b/i.exec(text);
    if (useSkill) return this.call('skill_read', { name: useSkill[1]!.toLowerCase() });
    const saveSkill = /\bsave (?:this|it) as a skill called ([a-z0-9][a-z0-9-]{1,63})(?:\s*:\s*([\s\S]+))?$/i.exec(text.trim());
    if (saveSkill) {
      const name = saveSkill[1]!.toLowerCase();
      const words = name.replace(/-/g, ' ');
      return this.call('skill_propose', {
        name,
        description: `How to ${words}, step by step`,
        triggers: [words],
        steps:
          saveSkill[2]?.trim() && saveSkill[2].trim().length >= 40
            ? saveSkill[2].trim()
            : `1. Restate the goal of ${words} in one line.\n2. Gather what is needed and check it.\n3. Do it, then say what was done and what is left.`,
      });
    }
    if (/\b(time|saat|date|tarih)\b/.test(lower)) return this.call('current_time', {});

    return this.answer(
      `${NOTE}\n\nYou said: “${text.slice(0, 200)}”.\n\nHere I understand a few requests:\n` +
        '- Attach a table (CSV or Excel) — I read it and lay it out\n' +
        '- Attach a document (PDF, Word, text) — I read its opening\n' +
        '- “Remember that …” — I propose it to memory, and say whether it was kept\n' +
        '- “What do you remember about …”\n' +
        '- “Run python: print(1+1)” — code in the sandbox, after you confirm\n' +
        '- “Make a csv file called fruit” — a file to download\n' +
        '- “Read https://…” or “Search the web for …”\n' +
        '- “Email someone@example.com: Subject | Body” — sent only if you confirm\n' +
        '- “Use the debugging skill”, or “Save this as a skill called weekly-digest”\n' +
        '- Ask for the time',
    );
  }

  /**
   * A team at work, by rule: the lead gives each member one task on the goal,
   * a member reports on its contract, the lead merges what came back, the
   * reviewer approves. Enough to watch a run move on a developer machine.
   */
  private teamRole(request: AgentModelRequest): AgentModelResult | null {
    const { system } = request;
    const first = request.messages.find((m) => m.role === 'user')?.content ?? '';
    const afterTool = request.messages.at(-1)?.role === 'tool';
    if (system.includes('— Team run: you lead —')) {
      if (afterTool) return this.answer('');
      const roster = [...system.matchAll(/^- ([^,—\n]+?)(?:, [^—\n]*)? — (lead|member)/gm)].map((m) => ({ name: m[1]!.trim(), role: m[2]! }));
      const members = roster.filter((r) => r.role === 'member');
      const workers = members.length > 0 ? members : roster;
      const goal = first.replace(/^Goal of this run:\s*/, '').trim();
      return this.call('plan_tasks', {
        tasks: workers.map((w, i) => ({ key: `t${i + 1}`, title: `${w.name}'s part`, goal, assignee: w.name })),
      });
    }
    if (system.includes('— Team run: you merge —')) {
      const parts = [...first.matchAll(/<<<data [0-9a-f]+ · ([^\n]*)\n([\s\S]*?)\n>>>data/g)].map((m) => `**${m[1]}**\n\n${m[2]}`);
      return this.call('merge_results', { result: `${NOTE}\n\n${parts.join('\n\n') || 'Nothing came back.'}` });
    }
    if (system.includes('— Team run: you review —')) return this.call('approve_result', {});
    if (system.includes('— Team run: you take one task —')) {
      const task = /^Task (\w+): (.*)$/m.exec(first);
      return this.answer(`${NOTE} I worked on ${task?.[1] ?? 'the task'} (${task?.[2] ?? ''}): here is what I would report, with sources.`);
    }
    return null;
  }

  /** What follows a tool's answer: a table read is shown as a card; anything else is said in words. */
  private afterTools(messages: AgentModelMessage[]): AgentModelResult {
    const answer = messages.at(-1) as Extract<AgentModelMessage, { role: 'tool' }>;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(answer.content);
    } catch {
      // A tool answer that is not JSON is said as it is.
    }
    const value = (parsed ?? {}) as Record<string, unknown>;
    if (typeof value['error'] === 'string') return this.answer(`${NOTE}\n\nThat did not work: ${value['error']}`);
    if (answer.name === 'read_table' && isSourceAnswer(parsed)) {
      const result = parsed.result as { name?: string };
      return this.call('present', {
        title: result.name ?? 'Table',
        layout: 'table',
        source: parsed.source,
        path: 'rows',
        header: true,
      });
    }
    if (answer.name === 'present') return this.answer(`${NOTE}\n\nHere it is, laid out above.`);
    if (answer.name === 'read_document' && isSourceAnswer(parsed)) {
      const result = parsed.result as { name?: string; text?: string; characters?: number };
      const opening = (result.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 280);
      return this.answer(
        `${NOTE}\n\n“${result.name ?? 'The document'}” has ${(result.characters ?? 0).toLocaleString('en-US')} characters. It opens:\n\n> ${opening}`,
      );
    }
    if (answer.name === 'memory_propose' && typeof value['state'] === 'string') {
      const kept = value['state'] === 'active';
      return this.answer(
        `${NOTE}\n\n${kept ? 'Remembered' : 'Not remembered'} — ${String(value['reason'] ?? value['state'])} (${String(value['tier'] ?? '')}).`,
      );
    }
    if (answer.name === 'memory_search' && isSourceAnswer(parsed)) {
      const results = ((parsed.result as { results?: { content: string; tier: string; trust: number }[] }).results ?? []);
      return this.answer(
        `${NOTE}\n\n${results.length === 0 ? 'I remember nothing about that.' : results.map((r) => `- [${r.tier} ${r.trust}] ${r.content}`).join('\n')}`,
      );
    }
    if (value['proposed'] === true) {
      return this.answer(`${NOTE}\n\n“${String(value['title'] ?? 'This')}” waits for you on the card above: nothing is done until you confirm it.`);
    }
    if (typeof value['actionId'] === 'string') {
      return this.answer(`${NOTE}\n\n${value['status'] === 'completed' ? 'Done, and recorded on its card.' : `That did not work: ${String(value['error'] ?? '')}`}`);
    }
    if (answer.name === 'file_create' && value['file']) {
      const file = value['file'] as { name: string; url: string };
      return this.answer(`${NOTE}\n\nHere it is: [${file.name}](${file.url}).`);
    }
    if ((answer.name === 'web_fetch' || answer.name === 'web_search') && isSourceAnswer(parsed)) {
      const result = parsed.result as { title?: string; text?: string; results?: { title: string; url: string }[] };
      const said = result.results
        ? result.results.map((r) => `- [${r.title}](${r.url})`).join('\n') || 'Nothing found.'
        : `“${result.title ?? 'The page'}” opens: ${(result.text ?? '').replace(/\s+/g, ' ').slice(0, 280)}`;
      return this.answer(`${NOTE}\n\n${said}`);
    }
    if (answer.name === 'skill_read' && typeof value['skill'] === 'string') {
      return this.answer(`${NOTE}\n\nI opened the skill “${String(value['name'])}” (version ${String(value['version'])}): ${String(value['description'])}.`);
    }
    if (answer.name === 'skill_propose' && typeof value['state'] === 'string') {
      return this.answer(
        `${NOTE}\n\n${value['state'] === 'rejected' ? 'The skill was refused by the scanner.' : `I proposed the skill “${String(value['name'])}”: it is replayed, and used only once you approve it on your Skills page.`}`,
      );
    }
    if (answer.name === 'current_time' && typeof value['local'] === 'string') {
      return this.answer(`${NOTE}\n\nIt is ${value['local']}.`);
    }
    return this.answer(`${NOTE}\n\nDone.`);
  }

  private call(name: string, args: Record<string, unknown>): AgentModelResult {
    const call: AgentToolCall = { id: `dev_${this.calls}`, name, arguments: JSON.stringify(args) };
    return { ...this.answer(''), toolCalls: [call], finishReason: 'tool_calls' };
  }

  private answer(text: string): AgentModelResult {
    return {
      text,
      toolCalls: [],
      finishReason: 'stop',
      usage: { input: 0, output: 0, cached: 0, costUsd: null },
      servedModel: 'development',
    };
  }
}

/** A summary by rule: what the person asked, newest last — enough to show the path working. */
function remembered(input: string): string {
  const asked = [...input.matchAll(/^\[[^\]]+\] Person: (.+)$/gm)].map((m) => `- ${m[1]!.slice(0, 200)}`);
  return [NOTE, 'Goals', ...(asked.length > 0 ? asked.slice(-20) : ['- (nothing the person asked)'])].join('\n');
}
