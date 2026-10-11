import { z } from 'zod';
import { timeZoneSchema } from './account.js';
import { ulidSchema } from './primitives.js';

/**
 * The agent's conversations (Phase 1; ported from App-Milyonus
 * `packages/contracts/src/agent.ts`, made general-purpose).
 *
 * A person talks to their agent; the agent answers and reads with its tools —
 * the tables and documents the person attached, the time. Changing anything
 * outside the conversation arrives in Phase 3, as proposals the person
 * confirms (D-11).
 *
 * What the browser needs — the limits, the views, the stream's events — is
 * plain values and types here. The request schemas are for the API.
 */

/** What the agent holds to, in one place — the API enforces, the page explains. */
export const AGENT_LIMITS = {
  /** Characters in one message from a person. */
  messageChars: 8000,
  /** Model calls in one turn before it stops and says so. */
  roundsPerTurn: 6,
  /** Tables and documents handed over with one message. */
  attachmentsPerMessage: 5,
  /** Lines in one table, and columns. */
  attachmentRows: 10_000,
  attachmentColumns: 50,
  /** Bytes in one uploaded file. */
  attachmentBytes: 8 * 1024 * 1024,
  /** Days an attachment is kept before the hourly pass deletes it (0006). */
  attachmentDays: 7,
  /** Pages in one PDF, and characters of text kept from any document. */
  documentPages: 50,
  documentChars: 200_000,
} as const;

/** Where the agent's answers come from on this deployment. */
export type AgentProvider = 'openrouter' | 'development' | 'unconfigured';

// ────────────────────────────────────────────────────────────────── requests

/** A model router's identifier — `anthropic/claude-sonnet-5-5`. Mirrors 0006's check. */
export const agentModelIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:/~-]{1,120}$/, 'expected a model identifier such as anthropic/claude-sonnet-5-5');

export const agentConversationCreateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  model: agentModelIdSchema.optional(),
});
export type AgentConversationCreate = z.infer<typeof agentConversationCreateSchema>;

export const agentConversationUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    model: agentModelIdSchema.optional(),
    pinned: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });
export type AgentConversationUpdate = z.infer<typeof agentConversationUpdateSchema>;

/**
 * How the agent works this turn: `ask` — answers and checks in before long
 * or ambiguous work; `auto` — carries the task through, choosing sensible
 * defaults; `plan` — writes a plan and does not carry it out yet.
 */
export const AGENT_MODES = ['ask', 'auto', 'plan'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/** Whether this runtime knows an IANA time zone by that name. */
export function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * A time zone the agent can compute in: the account's shape, and one this
 * runtime knows — a zone it does not would fail every time it is read.
 */
export const agentTimeZoneSchema = timeZoneSchema.refine(isKnownTimeZone, 'Unknown time zone; use an IANA name such as Europe/Istanbul.');

export const agentMessageSchema = z.object({
  content: z.string().trim().min(1, 'Write a message').max(AGENT_LIMITS.messageChars),
  attachmentIds: z.array(ulidSchema).max(AGENT_LIMITS.attachmentsPerMessage).default([]),
  /**
   * The person's own time zone — the page sends the browser's. A time they
   * give is read in it. Absent, their profile's.
   */
  timeZone: agentTimeZoneSchema.optional(),
  /**
   * An earlier message of the person's that this one replaces — an edit, or
   * the same words asked again. What lies between is superseded.
   */
  revises: ulidSchema.optional(),
  mode: z.enum(AGENT_MODES).optional(),
});
export type AgentMessageInput = z.infer<typeof agentMessageSchema>;

/** A table pasted as text — tab-, comma- or semicolon-separated. A file is sent as itself. */
export const agentPastedTableSchema = z.object({
  name: z.string().trim().min(1).max(255).default('Pasted table'),
  text: z.string().min(1).max(AGENT_LIMITS.attachmentBytes),
});
export type AgentPastedTable = z.infer<typeof agentPastedTableSchema>;

/** A rating of an answer: up or down, and why. */
export const agentFeedbackSchema = z.object({
  rating: z.union([z.literal(1), z.literal(-1)]),
  note: z.string().trim().max(1000).default(''),
});
export type AgentFeedbackInput = z.infer<typeof agentFeedbackSchema>;

/** A search inside conversations: two characters at least. */
export const agentSearchSchema = z.object({ q: z.string().trim().min(2).max(200) });

/** A conversation taken out as a document. */
export const agentExportSchema = z.object({ format: z.enum(['md']).default('md') });

// ───────────────────────────────────────────────────────────────────── views

/** A model as a person chooses it: in plain words, its identifier only for those who ask. */
export type AgentModelTier = 'fast' | 'balanced' | 'deep';
export interface AgentModelOption {
  id: string;
  /** "Fast", "Balanced", "Deep" — or a deployment's own name for it. */
  label: string;
  tier: AgentModelTier;
  description: string;
}

/**
 * Today's allowance in words a person reads: the share used and a rough
 * count of messages left, with the tokens behind them.
 */
export interface AgentAllowance {
  usedShare: number;
  messagesLeft: number;
  tokens: { used: number; ceiling: number };
}

/** What the agent page needs to know before the first message. */
export interface AgentStatus {
  /** Who is reading — the page greets them by the first word of their name; empty when not given. */
  reader: { name: string };
  configured: boolean;
  provider: AgentProvider;
  defaultModel: string;
  /** The models a person may choose, in plain words. */
  modelOptions: AgentModelOption[];
  allowance: AgentAllowance;
  limits: typeof AGENT_LIMITS;
}

export interface AgentConversationSummary {
  id: string;
  title: string;
  model: string;
  lastMessageAt: string;
  createdAt: string;
  /** Set when pinned; pinned conversations come first. */
  pinnedAt: string | null;
  /**
   * The last message the agent's summary of the conversation covers — the
   * page draws a divider after it — or null when nothing is summarised yet.
   */
  summarizedThrough: string | null;
  summarizedAt: string | null;
}

export interface AgentToolCallView {
  id: string;
  name: string;
  /** In words, for the thread: "Read the document". */
  summary: string;
}

export interface AgentMessageView {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** The agent's messages: the tools it called in this step. */
  toolCalls: AgentToolCallView[];
  /** A tool's answer: which tool. */
  toolName: string | null;
  /** A person's message: what was handed over with it — tables by their lines, documents by their kind. */
  attachments: { id: string; name: string; rows: number; kind?: 'document' }[];
  model: string | null;
  /** The agent's reasoning for this step, when its model gave one. */
  reasoning: string | null;
  /** A person's message: the earlier one of theirs it replaces. */
  revises: string | null;
  /** Replaced by a later edit: kept, folded, and no longer read by the agent. */
  superseded: boolean;
  /** An agent's answer: the reader's own rating of it. */
  rating: 1 | -1 | null;
  createdAt: string;
}

/**
 * Which messages a later edit superseded: for each message that revises an
 * earlier one, everything from that one up to it. Messages in order; a
 * revised message outside them (older than the window read) supersedes all
 * before the revision. The one rule, for the server and the page alike.
 */
export function agentSupersededIds(messages: readonly { id: string; revises?: string | null }[]): Set<string> {
  const superseded = new Set<string>();
  messages.forEach((m, at) => {
    if (!m.revises) return;
    const from = messages.findIndex((x) => x.id === m.revises);
    for (let i = Math.max(0, from); i < at; i += 1) superseded.add(messages[i]!.id);
  });
  return superseded;
}

/** Words found inside one of the reader's conversations. */
export interface AgentSearchHit {
  conversationId: string;
  conversationTitle: string;
  messageId: string;
  role: 'user' | 'assistant';
  /** The matching passage, trimmed around the words. */
  excerpt: string;
  createdAt: string;
}

export interface AgentAttachmentView {
  id: string;
  name: string;
  /** A table keeps its lines; a document — a report, a contract — its text. */
  kind: 'table' | 'document';
  rowCount: number;
  columnCount: number;
  /** A document's pages (a PDF's) and characters of text; null for a table. */
  pages: number | null;
  characters: number | null;
  /** The first line, which is often — not always — a header. */
  firstRow: string[];
  expiresAt: string;
}

export interface AgentConversationView {
  conversation: AgentConversationSummary;
  messages: AgentMessageView[];
  attachments: AgentAttachmentView[];
  /**
   * What the agent remembers of the conversation before the divider, in its
   * own words: read by the model in place of those messages.
   */
  memory: string | null;
}

/** What /compact answers: the conversation, the summary now read in place of what it covers, and how much it covers. */
export interface AgentCompaction {
  conversation: AgentConversationSummary;
  memory: string;
  /** Messages summarised now, on top of any earlier summary. */
  messages: number;
}

/**
 * Why a turn ended before the agent was done: too many steps, too long, its
 * token allowance — for the turn or the day — or the person asked it to stop.
 */
export type AgentTurnStop = 'rounds' | 'time' | 'budget' | 'stopped';

/** What one turn spent, across its model calls. */
export interface AgentTurnUsage {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  /** As the model router reported it; null when it reported none. */
  costUsd: number | null;
}

/** What one turn answers: what was said in it. */
export interface AgentTurn {
  conversation: AgentConversationSummary;
  messages: AgentMessageView[];
  stopped: AgentTurnStop | null;
  usage: AgentTurnUsage;
}

/** What the streaming route sends, one server-sent event each, as the turn happens. */
export type AgentStreamEvent =
  | { type: 'message'; message: AgentMessageView }
  /** A piece of the agent's answer as it is written; the round's `message` then carries it whole. */
  | { type: 'text'; round: number; text: string }
  | { type: 'step'; tool: string; summary: string }
  | { type: 'done'; turn: AgentTurn }
  | { type: 'error'; code: string; message: string };
