import { Inject, Injectable } from '@nestjs/common';
import {
  AGENT_LIMITS,
  type AgentAllowance,
  type AgentCompaction,
  type AgentConversationCreate,
  type AgentConversationSummary,
  type AgentConversationUpdate,
  type AgentConversationView,
  type AgentFeedbackInput,
  type AgentMessageInput,
  type AgentMode,
  type AgentSearchHit,
  type AgentStatus,
  type AgentStreamEvent,
  type AgentTurn,
  type AgentTurnStop,
  type AgentTurnUsage,
  ErrorCode,
  type Principal,
  agentSupersededIds,
} from '@milyonuse/contracts';
import type pg from 'pg';
import { AppError } from '../../common/app-error.js';
import { AppLogger } from '../../common/logging/logger.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { rethrowDatabaseError } from '../tenancy/database-error.js';
import { UsageMeter, todayOf } from '../usage/usage.meter.js';
import {
  AGENT_MODEL,
  type AgentModel,
  AgentModelError,
  type AgentModelMessage,
  type AgentModelResult,
  type AgentModelUsage,
} from './agent-model.port.js';
import { AgentStore, type MessageRow, attachmentView, conversationView, messageView } from './agent.store.js';
import { AgentToolbox } from './agent.toolbox.js';
import { forModel, keepAnswer, keepSource, newSourceId } from './answers.js';
import {
  type ContextTurn,
  SUMMARY_CHARS,
  SUMMARY_INSTRUCTIONS,
  SUMMARY_OUTPUT_TOKENS,
  charsOfTokens,
  summaryInput,
  windowOf,
} from './context.js';
import { MODEL_CHARS } from './fit.js';
import { modelOptions, offeredModels } from './models.js';
import { AGENT_PROMPT_VERSION, type AgentContext, stablePrompt, systemPrompt } from './prompt.js';

/** A turn answered in one response stays inside the host's 120 s to a first byte. */
const TURN_LIMIT_MS = 100_000;
/**
 * A streamed turn sends its first byte at once, so only the function's own
 * limit applies — 300 s on Vercel (D-05) — with room left to write its last
 * messages.
 */
export const STREAMED_TURN_LIMIT_MS = 240_000;
/** Not worth starting a model call with less than this left. */
const MIN_CALL_MS = 15_000;
/**
 * Messages a turn loads past the summary's boundary — far more than a window
 * holds; the budget decides what the model reads of them.
 */
const CONTEXT_ROWS = 400;
/** What the model rereads of a tool answer from an earlier turn; the turn in progress reads them at MODEL_CHARS. */
const AGED_ANSWER_CHARS = 4_000;
/** A summary call's own time limit. */
const SUMMARY_TIMEOUT_MS = 60_000;
/**
 * What one model call may write. Output is paid per token written, not per
 * token allowed; a cut call is noticed below, never run.
 */
export const MAX_OUTPUT_TOKENS = 16_000;
/** What the model is told when its call was cut at the output limit. */
export const CUT_CALL =
  'This call was cut off at the output limit before its arguments were complete, so it was not run. Do not repeat it as it was: ask for less at a time, or split the work into smaller steps.';
/** Tokens a message is taken to cost until the person has a week of their own to average. */
const TOKENS_PER_MESSAGE = 25_000;
/** The title a conversation starts with, until its first message names it. */
const NEW_TITLE = 'New conversation';

type StopReason = 'rounds' | 'time' | 'turn_tokens' | 'day_tokens' | 'stopped';

const STOPPED: Record<StopReason, string> = {
  stopped: 'Stopped, as you asked. What was done before is kept; nothing else was started.',
  rounds: 'I have taken as many steps as one reply allows. Say “continue” and I will pick up where I left off.',
  time: 'This is taking longer than one reply allows. Say “continue” and I will pick up where I left off.',
  turn_tokens:
    'This reply has used the share of your allowance one reply may take. Say “continue” and I will pick up where I left off.',
  day_tokens:
    'You have used today’s agent allowance, so I stopped here. What I did so far is kept. It starts again at midnight UTC.',
};

/**
 * Conversations with the agent, and a turn of one (ported from App-Milyonus
 * `modules/agent/agent.service.ts`).
 *
 * A turn: the person's message is kept; the model reads the server's context
 * — who is asking, when, with which attachments — and the recent
 * conversation, and answers or calls tools; tools run as the person; then the
 * model reads the tools' answers, and so on, a few steps at most, until it
 * answers in words.
 *
 * The model is called outside any database transaction — a call can take a
 * minute — and every message is written as it happens, so an interrupted turn
 * leaves the conversation as far as it got, whether or not anyone is still
 * reading the stream.
 */
@Injectable()
export class AgentService {
  /** How often a running turn looks for a request to stop it. Tests shorten it. */
  static stopPollMs = 1500;

  private readonly offered: string[];

  constructor(
    private readonly store: AgentStore,
    private readonly toolbox: AgentToolbox,
    private readonly usage: UsageMeter,
    @Inject(AGENT_MODEL) private readonly model: AgentModel,
    @Inject(ENV) private readonly env: Env,
    private readonly logger: AppLogger,
  ) {
    this.offered = offeredModels(env);
  }

  async status(principal: Principal): Promise<AgentStatus> {
    const { name, used, perMessage } = await this.store.run(principal, async (client) => {
      const { rows } = await client.query<{ name: string }>(`SELECT btrim(name) AS name FROM users WHERE id = $1`, [
        principal.userId,
      ]);
      return {
        name: rows[0]?.name ?? '',
        used: await todayOf(client, principal.memberId, 'agent.tokens'),
        perMessage: await this.tokensPerMessage(client, principal),
      };
    });
    return {
      reader: { name },
      configured: this.model.name !== 'unconfigured',
      provider: this.model.name,
      defaultModel: this.env.AGENT_MODEL,
      modelOptions: modelOptions(this.offered, this.env.AGENT_MODEL_LABELS),
      allowance: this.allowanceOf(used, perMessage),
      limits: AGENT_LIMITS,
    };
  }

  // ─────────────────────────────────────────────────────────── conversations

  async list(principal: Principal): Promise<AgentConversationSummary[]> {
    return (await this.store.run(principal, (client) => this.store.conversations(client))).map(conversationView);
  }

  async create(principal: Principal, input: AgentConversationCreate): Promise<AgentConversationSummary> {
    const model = this.checkModel(input.model ?? this.env.AGENT_MODEL);
    const row = await this.store.run(principal, (client) =>
      this.store.createConversation(client, principal, { title: input.title ?? NEW_TITLE, model }),
    );
    return conversationView(row);
  }

  async get(principal: Principal, conversationId: string): Promise<AgentConversationView> {
    return this.store.run(principal, async (client) => {
      const conversation = await this.store.conversation(client, conversationId);
      const [messages, attachments, ratings, memory] = await Promise.all([
        this.store.messages(client, conversationId),
        this.store.attachments(client, conversationId),
        this.store.ratings(client, conversationId),
        this.store.summary(client, conversationId),
      ]);
      const summaries = this.toolbox.summaries();
      // Folded by a later edit, and how the person rated each answer.
      const superseded = agentSupersededIds(messages);
      return {
        conversation: conversationView(conversation),
        messages: messages.map((m) =>
          messageView(m, summaries, { superseded: superseded.has(m.id), rating: ratings.get(m.id) ?? null }),
        ),
        attachments: attachments.map(attachmentView),
        memory,
      };
    });
  }

  /** Words inside the person's conversations, newest first. */
  async search(principal: Principal, q: string): Promise<AgentSearchHit[]> {
    return this.store.run(principal, async (client) =>
      (await this.store.search(client, q)).map((r) => ({
        conversationId: r.conversation_id,
        conversationTitle: r.title,
        messageId: r.message_id,
        role: r.role,
        excerpt: r.excerpt.replace(/\s+/g, ' ').trim(),
        createdAt: r.created_at.toISOString(),
      })),
    );
  }

  async update(
    principal: Principal,
    conversationId: string,
    input: AgentConversationUpdate,
  ): Promise<AgentConversationSummary> {
    const model = input.model === undefined ? undefined : this.checkModel(input.model);
    const row = await this.store.run(principal, (client) =>
      this.store.updateConversation(client, conversationId, { title: input.title, model, pinned: input.pinned }),
    );
    return conversationView(row);
  }

  /** Asks the conversation's running turn to stop; it stops at its next safe point, keeping what it did. */
  async stop(principal: Principal, conversationId: string): Promise<{ stopping: true }> {
    await this.store.run(principal, async (client) => {
      await this.store.conversation(client, conversationId);
      await this.store.requestStop(client, conversationId);
    });
    return { stopping: true };
  }

  /** The conversation goes, with its messages, attachments and ratings. */
  async remove(principal: Principal, conversationId: string): Promise<{ deleted: true }> {
    const deleted = await this.store.run(principal, (client) => this.store.deleteConversation(client, conversationId));
    if (!deleted) throw AppError.notFound('Conversation');
    return { deleted: true };
  }

  /**
   * Was this answer good? Up or down, with a note, and the person may change
   * their mind. The database copies the model and the instructions' version
   * that gave the answer (0006, app.guard_agent_feedback).
   */
  async rate(
    principal: Principal,
    messageId: string,
    input: AgentFeedbackInput,
  ): Promise<{ messageId: string; rating: 1 | -1; note: string }> {
    return this.store.run(principal, async (client) => {
      // A message in someone else's conversation is not visible here: the same "not found".
      const { rows } = await client.query(`SELECT 1 FROM agent_messages WHERE id = $1`, [messageId]);
      if (!rows[0]) throw AppError.notFound('Message');
      try {
        await client.query(
          `INSERT INTO agent_feedback (organization_id, member_id, message_id, rating, note)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (message_id, member_id)
           DO UPDATE SET rating = EXCLUDED.rating, note = EXCLUDED.note`,
          [principal.organizationId, principal.memberId, messageId, input.rating, input.note],
        );
      } catch (error) {
        rethrowDatabaseError(error);
      }
      return { messageId, rating: input.rating, note: input.note };
    });
  }

  // ─────────────────────────────────────────────────────────────── a turn

  async send(
    principal: Principal,
    conversationId: string,
    input: AgentMessageInput,
    emit: (event: AgentStreamEvent) => void = () => {},
    options: { streamed?: boolean } = {},
  ): Promise<AgentTurn> {
    const turnLimit = options.streamed ? STREAMED_TURN_LIMIT_MS : TURN_LIMIT_MS;
    this.requireModel();
    const who = { organizationId: principal.organizationId, memberId: principal.memberId };
    if ((await this.usage.today(who, 'agent.tokens')) >= this.env.AGENT_DAILY_TOKENS) {
      throw new AppError(
        ErrorCode.AGENT_BUDGET_EXCEEDED,
        'You have used today’s agent allowance. It starts again at midnight UTC.',
      );
    }

    const started = Date.now();
    const mode: AgentMode = input.mode ?? 'ask';
    const created: MessageRow[] = [];

    // The person's message, with what was handed over with it.
    const setup = await this.store.run(principal, async (client) => {
      const conversation = await this.store.conversation(client, conversationId);
      // A model this deployment no longer offers: the conversation goes on, on the default.
      if (!this.offered.includes(conversation.model)) {
        conversation.model = this.env.AGENT_MODEL;
        await this.store.updateConversation(client, conversationId, { model: conversation.model });
      }
      const attachments = await this.store.attachments(client, conversationId);
      const handed = input.attachmentIds.map((id) => {
        const found = attachments.find((a) => a.id === id);
        if (!found) throw AppError.notFound('Attachment');
        return found.kind === 'document'
          ? { id: found.id, name: found.name, rows: 0, kind: 'document' as const }
          : { id: found.id, name: found.name, rows: found.row_count };
      });
      try {
        created.push(
          await this.store.addMessage(client, principal, conversationId, {
            role: 'user',
            content: input.content,
            attachments: handed,
            revises: input.revises,
          }),
        );
      } catch (error) {
        // A revision of anything but the person's own message here (0006).
        rethrowDatabaseError(error);
      }
      if (conversation.title === NEW_TITLE) {
        const title = input.content.replace(/\s+/g, ' ').trim().slice(0, 60) || NEW_TITLE;
        await this.store.updateConversation(client, conversationId, { title });
      }
      // The turn's start by the database's clock — what a request to stop is compared with.
      const clock = await client.query<{ now: Date }>(`SELECT clock_timestamp() AS now`);
      return {
        conversation,
        attachments,
        // What the agent's summary does not cover yet; the summary stands in for the rest.
        history: await this.store.messagesAfterSummary(client, conversationId, CONTEXT_ROWS),
        summary: await this.store.summary(client, conversationId),
        startedAt: clock.rows[0]!.now,
        person: await this.person(client, principal),
      };
    });
    const shown = this.toolbox.summaries();
    const show = (row: MessageRow) => emit({ type: 'message', message: messageView(row, shown) });
    show(created[0]!);
    const { conversation } = setup;
    const timeZone = input.timeZone ?? setup.person.timeZone;

    const spent: AgentTurnUsage = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: null };
    let cachedIn = 0;
    const count = (usage: AgentModelUsage | null) => {
      spent.calls += 1;
      if (!usage) return;
      spent.tokensIn += usage.input;
      spent.tokensOut += usage.output;
      cachedIn += usage.cached;
      if (usage.costUsd !== null) spent.costUsd = (spent.costUsd ?? 0) + usage.costUsd;
    };

    // What no longer fits the window is summarised before the turn reads it.
    let history: MessageRow[] = setup.history;
    let summary = setup.summary;
    const remembered = await this.remember(principal, conversation, history, summary, count);
    if (remembered) {
      ({ history, summary } = remembered);
      emit({ type: 'step', tool: 'compact', summary: 'Summarised the earlier conversation' });
    }

    const context: AgentContext = {
      now: new Date(),
      timeZone,
      person: { name: setup.person.name, locale: setup.person.locale },
      mode,
      summary,
      attachments: setup.attachments.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        rows: a.row_count,
        columns: a.column_count,
        firstRow: a.rows[0] ?? [],
        pages: a.pages,
        characters: a.text_length,
      })),
    };
    const system = systemPrompt(context);
    // The instructions come first and never change between calls: a provider caches them.
    const stable = stablePrompt();
    const cacheablePrefix = system.startsWith(stable) ? stable.length : undefined;
    const tools = this.toolbox.specs();

    let stopped: StopReason | null = null;
    let lastInput = 0;
    let round = 0;
    // A request to stop, from any instance, reaches this one through the database.
    const stopper = new AbortController();
    const watch = setInterval(() => {
      this.store
        .run(principal, (client) => this.store.stopRequested(client, conversationId, setup.startedAt))
        .then((asked) => {
          if (asked) stopper.abort();
        })
        .catch(() => {
          // A missed look is retried on the next tick.
        });
    }, AgentService.stopPollMs);
    try {
      for (; ; round += 1) {
        if (stopper.signal.aborted) {
          stopped = 'stopped';
          break;
        }
        if (round >= AGENT_LIMITS.roundsPerTurn) {
          stopped = 'rounds';
          break;
        }
        const remaining = turnLimit - (Date.now() - started);
        if (remaining < MIN_CALL_MS) {
          stopped = 'time';
          break;
        }
        // The ceilings hold before every call, not only the first: what the
        // next call will likely take is what the last one read, plus its answer.
        if (round > 0) {
          const next = lastInput + MAX_OUTPUT_TOKENS;
          if (spent.tokensIn + spent.tokensOut + next > this.env.AGENT_TURN_TOKENS) {
            stopped = 'turn_tokens';
            break;
          }
          // Read again, not carried: the person's other conversations spend too.
          if ((await this.usage.today(who, 'agent.tokens')) + next > this.env.AGENT_DAILY_TOKENS) {
            stopped = 'day_tokens';
            break;
          }
        }

        let result: AgentModelResult;
        try {
          result = await this.model.complete({
            model: conversation.model,
            system,
            cacheablePrefix,
            messages: this.forModel(history),
            tools,
            maxTokens: MAX_OUTPUT_TOKENS,
            user: principal.memberId,
            signal: AbortSignal.any([AbortSignal.timeout(remaining), stopper.signal]),
            // A streamed turn shows the answer as it is written.
            ...(options.streamed ? { onText: (text: string) => emit({ type: 'text', round, text }) } : {}),
          });
        } catch (error) {
          if (!(error instanceof AgentModelError)) throw error;
          count(error.usage);
          await this.usage.agentCall(who, error.usage);
          // Asked to stop while the model was answering: the call is dropped, the turn ends here.
          if (stopper.signal.aborted) {
            stopped = 'stopped';
            break;
          }
          this.logger.warn('agent turn stopped by the model', { reason: error.reason, round });
          // Past the first step the conversation has moved on; the person is told where it stopped.
          if (round > 0 && error.reason === 'timeout') {
            stopped = 'time';
            break;
          }
          throw new AppError(ErrorCode.AGENT_MODEL_FAILED, error.publicMessage, { context: { reason: error.reason } });
        }
        count(result.usage);
        lastInput = result.usage.input;
        await this.usage.agentCall(who, result.usage);

        // Words cut at the output limit say so, rather than ending mid-sentence as if finished.
        const text =
          result.finishReason === 'length' && result.toolCalls.length === 0 && result.text.trim()
            ? `${result.text.trimEnd()}… (cut short — say “continue” for the rest)`
            : result.text;
        const reply = await this.store.run(principal, (client) =>
          this.store.addMessage(client, principal, conversationId, {
            role: 'assistant',
            content: text.slice(0, 100_000),
            toolCalls: result.toolCalls,
            model: result.servedModel,
            promptVersion: AGENT_PROMPT_VERSION,
            tokensIn: result.usage.input,
            tokensCached: result.usage.cached,
            tokensOut: result.usage.output,
            costUsd: result.usage.costUsd,
            reasoning: result.reasoning?.slice(0, 40_000),
          }),
        );
        show(reply);
        created.push(reply);
        history.push(reply);
        if (result.toolCalls.length === 0) break;

        // An answer cut at the output limit: a call whose arguments did not arrive whole is not run.
        const cut = result.finishReason === 'length';
        if (cut) {
          this.logger.warn('agent answer cut at the output limit', {
            round,
            calls: result.toolCalls.length,
            tokensOut: result.usage.output,
          });
        }
        for (const call of result.toolCalls) {
          // A step not yet begun is not begun once a stop is asked; the model reads it as not completed.
          if (stopper.signal.aborted) break;
          emit({ type: 'step', tool: call.name, summary: shown.get(call.name) ?? call.name });
          const answer =
            cut && !parses(call.arguments)
              ? JSON.stringify({ error: CUT_CALL })
              : await this.runTool(principal, conversationId, timeZone, call.name, call.arguments);
          const toolMessage = await this.store.run(principal, (client) =>
            this.store.addMessage(client, principal, conversationId, {
              role: 'tool',
              content: answer,
              toolCallId: call.id,
              toolName: /^[a-z_]{1,64}$/.test(call.name) ? call.name : 'unknown_tool',
            }),
          );
          show(toolMessage);
          created.push(toolMessage);
          history.push(toolMessage);
        }
      }
    } finally {
      clearInterval(watch);
    }

    if (stopped) {
      const note = await this.store.run(principal, (client) =>
        this.store.addMessage(client, principal, conversationId, { role: 'assistant', content: STOPPED[stopped] }),
      );
      show(note);
      created.push(note);
    }

    const fresh = await this.store.run(principal, (client) => this.store.conversation(client, conversationId));
    const ended: AgentTurnStop | null = stopped === 'turn_tokens' || stopped === 'day_tokens' ? 'budget' : stopped;
    // One line a turn: what a reply costs is the measure the product is priced by.
    this.logger.log('agent turn', {
      conversationId,
      model: conversation.model,
      rounds: round + (stopped ? 0 : 1),
      calls: spent.calls,
      tokensIn: spent.tokensIn,
      tokensCached: cachedIn,
      tokensOut: spent.tokensOut,
      costUsd: spent.costUsd,
      ms: Date.now() - started,
      stopped,
    });
    return {
      conversation: conversationView(fresh),
      messages: created.map((m) => messageView(m, shown)),
      stopped: ended,
      usage: spent,
    };
  }

  /** Runs one tool call. The answer is what the model reads — a read kept whole, as a source. */
  private async runTool(
    principal: Principal,
    conversationId: string,
    timeZone: string,
    name: string,
    rawArguments: string,
  ): Promise<string> {
    const outcome = await this.toolbox.run(name, rawArguments, { principal, conversationId, timeZone });
    if (outcome.kind === 'error') return JSON.stringify({ error: outcome.message });
    // A read is kept whole, as a source `present` can lay out; the model rereads it fitted.
    if (!this.toolbox.isSource(name)) return keepAnswer(outcome.data);
    const from = outcome.from ?? this.toolbox.summaries().get(name) ?? name;
    return keepSource(newSourceId(), from, outcome.data);
  }

  // ─────────────────────────────────────────────────────── what the model reads

  /**
   * The conversation as the model is sent it: the newest whole turns that fit
   * the context budget, the turn in progress always; every tool call answered
   * (a turn cut short leaves one unanswered, and a model router refuses
   * that); every answer fitted, valid and saying what it left out — an
   * earlier turn's shorter than the one in progress. What falls outside the
   * budget is in the summary, once the next turn has written it (remember).
   */
  private forModel(history: MessageRow[]): AgentModelMessage[] {
    const { kept } = windowOf(this.turnsOf(history), charsOfTokens(this.env.AGENT_CONTEXT_TOKENS));
    // The model's conversation starts at a person's message.
    const from = kept.findIndex((t) => t.rows[0]?.role === 'user');
    return (from < 0 ? kept.slice(-1) : kept.slice(from)).flatMap((t) => t.messages);
  }

  /**
   * History in turns — a person's message and what followed it — each as the
   * model reads it. What a later edit superseded is kept, but the agent no
   * longer reads it.
   */
  private turnsOf(history: MessageRow[]): ContextTurn<MessageRow>[] {
    const superseded = agentSupersededIds(history);
    const live = history.filter((m) => !superseded.has(m.id));
    const groups: MessageRow[][] = [];
    for (const m of live) {
      if (m.role === 'user' || groups.length === 0) groups.push([m]);
      else groups.at(-1)!.push(m);
    }
    return groups.map((rows, index) => ({
      rows,
      messages: render(rows, index < groups.length - 1 ? AGED_ANSWER_CHARS : MODEL_CHARS),
    }));
  }

  // ──────────────────────────────────────────────────── what the agent remembers

  /**
   * Before a turn: when the turns past the summary no longer fit the context
   * budget, the oldest of them are summarised — enough that what stays fills
   * half the budget, so this happens now and then rather than every turn —
   * and the summary's boundary moves past them. A summary that fails leaves
   * the conversation as it was; the turn goes on with the window alone.
   */
  private async remember(
    principal: Principal,
    conversation: { id: string; model: string },
    history: MessageRow[],
    summary: string | null,
    count: (usage: AgentModelUsage | null) => void,
  ): Promise<{ history: MessageRow[]; summary: string } | null> {
    const budget = charsOfTokens(this.env.AGENT_CONTEXT_TOKENS);
    const turns = this.turnsOf(history);
    if (windowOf(turns, budget).dropped.length === 0) return null;
    const { dropped } = windowOf(turns, budget / 2);
    const rows = dropped.flatMap((t) => t.rows);
    const through = rows.at(-1)!;
    try {
      const text = await this.summarise(principal, conversation.model, summary, rows, count);
      await this.store.run(principal, (client) => this.store.setSummary(client, conversation.id, text, through.id));
      const after = history.findIndex((m) => m.id === through.id) + 1;
      this.logger.log('agent conversation summarised', {
        conversationId: conversation.id,
        messages: rows.length,
        through: through.id,
        chars: text.length,
      });
      return { history: history.slice(after), summary: text };
    } catch (error) {
      this.logger.warn('agent summary failed; the turn reads the window alone', {
        conversationId: conversation.id,
        err: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** One summary call: the earlier summary merged with `rows`, no tools, metered like every call. */
  private async summarise(
    principal: Principal,
    model: string,
    previous: string | null,
    rows: MessageRow[],
    count: (usage: AgentModelUsage | null) => void,
  ): Promise<string> {
    const who = { organizationId: principal.organizationId, memberId: principal.memberId };
    let result: AgentModelResult;
    try {
      result = await this.model.complete({
        model,
        system: SUMMARY_INSTRUCTIONS,
        messages: [{ role: 'user', content: summaryInput(previous, rows) }],
        tools: [],
        maxTokens: SUMMARY_OUTPUT_TOKENS,
        user: principal.memberId,
        signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof AgentModelError) {
        count(error.usage);
        await this.usage.agentCall(who, error.usage);
      }
      throw error;
    }
    count(result.usage);
    await this.usage.agentCall(who, result.usage);
    const text = result.text.trim();
    if (!text) throw new Error('The summary came back empty.');
    return text.slice(0, SUMMARY_CHARS);
  }

  /**
   * /compact: the agent summarises the whole conversation now, and from here
   * on reads the summary and what follows it. The transcript stays whole on
   * the page.
   */
  async compact(principal: Principal, conversationId: string): Promise<AgentCompaction> {
    this.requireModel();
    const who = { organizationId: principal.organizationId, memberId: principal.memberId };
    if ((await this.usage.today(who, 'agent.tokens')) >= this.env.AGENT_DAILY_TOKENS) {
      throw new AppError(
        ErrorCode.AGENT_BUDGET_EXCEEDED,
        'Today’s agent allowance is used up, so the conversation cannot be summarised now. It starts again at midnight UTC.',
      );
    }
    const { conversation, rows, summary } = await this.store.run(principal, async (client) => {
      const found = await this.store.conversation(client, conversationId);
      const after = await this.store.messagesAfterSummary(client, conversationId, CONTEXT_ROWS);
      const superseded = agentSupersededIds(after);
      return {
        conversation: found,
        rows: after.filter((m) => !superseded.has(m.id)),
        summary: await this.store.summary(client, conversationId),
      };
    });
    if (rows.length === 0) throw new AppError(ErrorCode.CONFLICT, 'Nothing has been said since the last summary.');
    let text: string;
    try {
      text = await this.summarise(principal, conversation.model, summary, rows, () => {});
    } catch (error) {
      if (error instanceof AgentModelError) {
        throw new AppError(ErrorCode.AGENT_MODEL_FAILED, error.publicMessage, { context: { reason: error.reason } });
      }
      throw error;
    }
    const fresh = await this.store.run(principal, async (client) => {
      try {
        await this.store.setSummary(client, conversationId, text, rows.at(-1)!.id);
      } catch (error) {
        rethrowDatabaseError(error);
      }
      return this.store.conversation(client, conversationId);
    });
    this.logger.log('agent conversation compacted', { conversationId, messages: rows.length, chars: text.length });
    return { conversation: conversationView(fresh), memory: text, messages: rows.length };
  }

  // ────────────────────────────────────────────────────────────── context

  /** The person, as their profile says: what the prompt names them, and the zone a time is read in. */
  private async person(
    client: pg.PoolClient,
    principal: Principal,
  ): Promise<{ name: string; locale: string; timeZone: string }> {
    const { rows } = await client.query<{ name: string; locale: string; time_zone: string }>(
      `SELECT btrim(name) AS name, locale, time_zone FROM users WHERE id = $1`,
      [principal.userId],
    );
    return { name: rows[0]?.name ?? '', locale: rows[0]?.locale ?? 'en', timeZone: rows[0]?.time_zone ?? 'UTC' };
  }

  /** What a message has cost the person over the last week — how "messages left" is counted. */
  private async tokensPerMessage(client: pg.PoolClient, principal: Principal): Promise<number> {
    const { rows } = await client.query<{ tokens: string; messages: string }>(
      `SELECT
         (SELECT COALESCE(sum(quantity), 0) FROM usage_daily
           WHERE member_id = $1 AND meter = 'agent.tokens'
             AND day > (now() AT TIME ZONE 'UTC')::date - 7) AS tokens,
         (SELECT count(*) FROM agent_messages m JOIN agent_conversations c ON c.id = m.conversation_id
           WHERE m.role = 'user' AND m.created_at > now() - interval '7 days') AS messages`,
      [principal.memberId],
    );
    const tokens = Number(rows[0]!.tokens);
    const messages = Number(rows[0]!.messages);
    // A few messages say little; until there are some, a typical one.
    return messages >= 3 && tokens > 0 ? Math.max(1000, tokens / messages) : TOKENS_PER_MESSAGE;
  }

  /** Today's allowance as a person reads it: a share, and roughly how many messages are left. */
  private allowanceOf(used: number, perMessage: number): AgentAllowance {
    const ceiling = this.env.AGENT_DAILY_TOKENS;
    return {
      usedShare: Math.min(1, used / Math.max(1, ceiling)),
      messagesLeft: Math.floor(Math.max(0, ceiling - used) / perMessage),
      tokens: { used, ceiling },
    };
  }

  // ─────────────────────────────────────────────────────────────── checks

  private requireModel(): void {
    if (this.model.name === 'unconfigured') {
      throw new AppError(ErrorCode.AGENT_NOT_CONFIGURED, 'The agent is not set up on this deployment yet.');
    }
  }

  /** A model this deployment offers. */
  private checkModel(model: string): string {
    if (!this.offered.includes(model)) {
      const labels = modelOptions(this.offered, this.env.AGENT_MODEL_LABELS).map((m) => m.label);
      throw new AppError(ErrorCode.VALIDATION_FAILED, `That model is not available. Choose one of: ${labels.join(', ')}.`);
    }
    return model;
  }
}

/** One turn's rows as the model reads them. */
function render(rows: MessageRow[], answerChars: number): AgentModelMessage[] {
  const out: AgentModelMessage[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const m = rows[i]!;
    if (m.role === 'user') {
      const handed = (m.attachments ?? [])
        .map((a) =>
          a.kind === 'document'
            ? `\n[document ${a.id} “${a.name}” — read it with read_document]`
            : `\n[table ${a.id} “${a.name}”: ${a.rows} lines — read it with read_table]`,
        )
        .join('');
      out.push({ role: 'user', content: `${m.content}${handed}` });
    } else if (m.role === 'assistant') {
      const calls = m.tool_calls ?? [];
      out.push({ role: 'assistant', content: m.content, toolCalls: calls });
      const answered = new Map<string, MessageRow>();
      while (rows[i + 1]?.role === 'tool') {
        const answer = rows[i + 1]!;
        if (answer.tool_call_id) answered.set(answer.tool_call_id, answer);
        i += 1;
      }
      for (const call of calls) {
        const answer = answered.get(call.id);
        out.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: answer
            ? forModel(answer.content, answer.tool_name, answerChars)
            : JSON.stringify({ error: 'This step did not complete.' }),
        });
      }
    }
    // A tool answer with no call before it — cut off by the window — is left out.
  }
  return out;
}

/** Whether a tool call's arguments arrived as whole JSON. */
function parses(raw: string): boolean {
  if (raw.trim() === '') return true;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}
