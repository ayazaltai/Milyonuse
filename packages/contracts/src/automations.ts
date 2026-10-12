import { z } from 'zod';
import type { AgentActionRisk } from './actions.js';
import { ulidSchema } from './primitives.js';
import type { RunSummaryView } from './teams.js';

/**
 * Automations, the Inbox and runs at a glance (Phase 6): a person's agents and
 * teams working without them at the screen — on a schedule, when something
 * changes or arrives, or at the press of a button — and one place for
 * everything that waits for their word. The rules live in 0013_automations.
 */

export const AUTOMATION_KINDS = ['schedule', 'monitor', 'goal', 'webhook', 'email', 'agent_event', 'manual'] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];
export const CADENCES = ['hourly', 'daily', 'weekdays', 'weekly', 'monthly'] as const;
export type Cadence = (typeof CADENCES)[number];

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

export const automationFieldsSchema = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  /** What it runs: exactly one of the person's agents or teams. */
  target: z.union([z.object({ agentId: ulidSchema }).strict(), z.object({ teamId: ulidSchema }).strict()]),
  prompt: z.string().trim().min(1).max(4000),
  policy: z.enum(['safe_only', 'trusted']),
  /**
   * `trusted` lets reversible work run with no one watching. It is set only
   * with this, after the person read what it means.
   */
  confirmTrusted: z.literal(true).optional(),
  timeZone: z.string().min(1).max(64),
  quietHours: z.object({ start: hhmm, end: hhmm }).nullable(),
  budgetTokens: z.number().int().min(10_000).max(5_000_000),
  dailyCap: z.number().int().min(1).max(500),
  failurePolicy: z.enum(['retry', 'pause', 'notify']),
  notify: z.array(z.enum(['inbox', 'email'])).max(2),
  cadence: z.enum(CADENCES).nullable(),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7),
  monthDay: z.number().int().min(1).max(31).nullable(),
  localTime: hhmm.nullable(),
  everyHours: z.number().int().min(1).max(24).nullable(),
  monitorUrl: z.string().url().startsWith('https://').max(2000).nullable(),
  monitorCondition: z.string().trim().max(500).nullable(),
  goalUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  watchAutomationId: ulidSchema.nullable(),
  watchTeamId: ulidSchema.nullable(),
  watchEvents: z.array(z.enum(['run.completed', 'run.failed'])).min(1).max(2),
});

export const automationCreateSchema = automationFieldsSchema.partial().extend({
  name: automationFieldsSchema.shape.name,
  kind: z.enum(AUTOMATION_KINDS),
  target: automationFieldsSchema.shape.target,
  prompt: automationFieldsSchema.shape.prompt,
});
export type AutomationCreate = z.infer<typeof automationCreateSchema>;

export const automationUpdateSchema = automationFieldsSchema
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to change' });
export type AutomationUpdate = z.infer<typeof automationUpdateSchema>;

export const automationDraftSchema = z.object({ text: z.string().trim().min(3).max(2000) });

export const automationRunSchema = z.object({
  /** What the run is given besides its prompt — for a manual or test run. */
  input: z.string().max(20_000).optional(),
});

export interface AutomationView {
  id: string;
  name: string;
  kind: AutomationKind;
  enabled: boolean;
  target: { agentId: string; teamId: null } | { agentId: null; teamId: string };
  targetName: string;
  prompt: string;
  policy: 'safe_only' | 'trusted';
  trustedConfirmedAt: string | null;
  timeZone: string;
  quietHours: { start: string; end: string } | null;
  budgetTokens: number;
  dailyCap: number;
  failurePolicy: 'retry' | 'pause' | 'notify';
  notify: ('inbox' | 'email')[];
  cadence: Cadence | null;
  weekdays: number[];
  monthDay: number | null;
  localTime: string | null;
  everyHours: number | null;
  nextRunAt: string | null;
  monitorUrl: string | null;
  monitorCondition: string | null;
  goalUntil: string | null;
  /** A webhook's address, and an email automation's. The signing secret is shown once, when it is made or replaced. */
  hook: { url: string; email: string; secret?: string } | null;
  watchAutomationId: string | null;
  watchTeamId: string | null;
  watchEvents: ('run.completed' | 'run.failed')[];
  consecutiveFailures: number;
  pausedReason: string | null;
  lastRunAt: string | null;
  lastOutcome: 'completed' | 'failed' | 'skipped' | 'waiting' | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationTriggerView {
  id: string;
  source: 'schedule' | 'monitor' | 'goal' | 'webhook' | 'email' | 'agent_event' | 'manual' | 'test';
  status: 'accepted' | 'started' | 'skipped' | 'failed';
  reason: string | null;
  runId: string | null;
  createdAt: string;
}

export interface AutomationDetailView extends AutomationView {
  triggers: AutomationTriggerView[];
  runs: RunSummaryView[];
  monitor: { lastCheckedAt: string | null; lastChangedAt: string | null; checks: number; changes: number; excerpt: string | null } | null;
}

export interface AutomationDraftView {
  kind: AutomationKind;
  name: string;
  prompt: string;
  cadence: Cadence | null;
  weekdays: number[];
  monthDay: number | null;
  localTime: string | null;
  everyHours: number | null;
  monitorUrl: string | null;
  monitorCondition: string | null;
  goalUntil: string | null;
  understood: string[];
}

// ─────────────────────────────────────────────────────────────── the inbox

export interface InboxItemView {
  id: string;
  kind: 'alert' | 'suggestion' | 'notice';
  title: string;
  body: string;
  link: string | null;
  automationId: string | null;
  /** A suggestion's automation, ready to make. */
  suggestion: AutomationDraftView | null;
  readAt: string | null;
  createdAt: string;
}

export interface InboxProposalView {
  id: string;
  conversationId: string;
  conversationTitle: string;
  tool: string;
  title: string;
  risk: AgentActionRisk;
  reversible: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface InboxMemoryView {
  id: string;
  content: string;
  tier: string;
  teamId: string | null;
  createdAt: string;
}

export interface InboxView {
  proposals: InboxProposalView[];
  waitingRuns: RunSummaryView[];
  memories: InboxMemoryView[];
  items: InboxItemView[];
}

/** What the bell counts. */
export interface InboxCount {
  total: number;
  unread: number;
}

export const inboxBulkSchema = z.object({
  ids: z.array(ulidSchema).min(1).max(50),
  timeZone: z.string().min(1).max(64).optional(),
});
