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
    if (/\b(time|saat|date|tarih)\b/.test(lower)) return this.call('current_time', {});

    return this.answer(
      `${NOTE}\n\nYou said: “${text.slice(0, 200)}”.\n\nHere I understand a few requests:\n` +
        '- Attach a table (CSV or Excel) — I read it and lay it out\n' +
        '- Attach a document (PDF, Word, text) — I read its opening\n' +
        '- “Remember that …” — I propose it to memory, and say whether it was kept\n' +
        '- “What do you remember about …”\n' +
        '- Ask for the time',
    );
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
