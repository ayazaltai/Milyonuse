import { z } from 'zod';
import { ulidSchema } from './primitives.js';

/**
 * Agent teams and runs (Phase 5): a person's agents working together — a lead
 * who plans, members who take tasks, a reviewer who checks — on runs the queue
 * advances in slices. The rules live in 0012_teams.
 */

export const TEAM_MODES = ['hierarchical', 'pipeline', 'debate'] as const;
export type TeamMode = (typeof TEAM_MODES)[number];
export const TEAM_ROLES = ['lead', 'member', 'reviewer'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export const RUN_STATUSES = ['queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const TASK_STATUSES = ['pending', 'running', 'done', 'failed', 'uncertain', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TEAM_LIMITS = {
  teams: 30,
  members: 8,
  /** Tasks a lead may plan for one run. */
  tasks: 12,
  /** Review rounds before the result is delivered as it stands. */
  revisions: 2,
  budgetTokens: { min: 10_000, max: 10_000_000 },
  goalChars: 4000,
} as const;

const teamMemberSchema = z.object({
  agentId: ulidSchema,
  role: z.enum(TEAM_ROLES),
  position: z.number().int().min(0).max(20).optional(),
  specialty: z.string().trim().max(300).optional(),
});

/** The roster's own rules, before the database's: one lead, at most one reviewer, no agent twice. */
const roster = z
  .array(teamMemberSchema)
  .min(1)
  .max(TEAM_LIMITS.members)
  .superRefine((members, ctx) => {
    if (members.filter((m) => m.role === 'lead').length !== 1) ctx.addIssue({ code: 'custom', message: 'A team has exactly one lead.' });
    if (members.filter((m) => m.role === 'reviewer').length > 1) ctx.addIssue({ code: 'custom', message: 'A team has at most one reviewer.' });
    if (new Set(members.map((m) => m.agentId)).size !== members.length) ctx.addIssue({ code: 'custom', message: 'An agent is on a team once.' });
  });

export const teamCreateSchema = z
  .object({
    /** A team template: its agents are made for this team. */
    template: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/).optional(),
    locale: z.enum(['en', 'tr']).default('en'),
    name: z.string().trim().min(1).max(60).optional(),
    purpose: z.string().trim().max(1000).optional(),
    mode: z.enum(TEAM_MODES).optional(),
    budgetTokens: z.number().int().min(TEAM_LIMITS.budgetTokens.min).max(TEAM_LIMITS.budgetTokens.max).optional(),
    members: roster.optional(),
  })
  .refine((v) => v.template !== undefined || (v.members !== undefined && v.name !== undefined), {
    message: 'A team is made from a template, or from a name and its members.',
  });
export type TeamCreate = z.infer<typeof teamCreateSchema>;

export const teamUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    purpose: z.string().trim().max(1000).optional(),
    mode: z.enum(TEAM_MODES).optional(),
    budgetTokens: z.number().int().min(TEAM_LIMITS.budgetTokens.min).max(TEAM_LIMITS.budgetTokens.max).optional(),
    members: roster.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to change' });
export type TeamUpdate = z.infer<typeof teamUpdateSchema>;

export const runStartSchema = z.object({
  goal: z.string().trim().min(3).max(TEAM_LIMITS.goalChars),
  /** Overrides the team's budget for this run. */
  budgetTokens: z.number().int().min(TEAM_LIMITS.budgetTokens.min).max(TEAM_LIMITS.budgetTokens.max).optional(),
  timeZone: z.string().min(1).max(64).optional(),
});
export type RunStart = z.infer<typeof runStartSchema>;

export const runResumeSchema = z.object({
  /** Tokens added to the budget before going on. */
  addTokens: z.number().int().min(1000).max(TEAM_LIMITS.budgetTokens.max).default(100_000),
});

export interface TeamMemberView {
  agentId: string;
  name: string;
  avatar: string;
  roleTitle: string;
  role: TeamRole;
  position: number;
  specialty: string;
  archived: boolean;
}

export interface TeamView {
  id: string;
  name: string;
  purpose: string;
  mode: TeamMode;
  budgetTokens: number;
  template: string | null;
  archivedAt: string | null;
  members: TeamMemberView[];
  runs: number;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamTemplateView {
  id: string;
  name: string;
  purpose: string;
  mode: TeamMode;
  members: { template: string; role: TeamRole; name: string; roleTitle: string; avatar: string; specialty: string }[];
}

export interface RunTaskView {
  id: string;
  key: string;
  title: string;
  goal: string;
  context: string;
  successCriteria: string;
  dependsOn: string[];
  assignedAgentId: string | null;
  status: TaskStatus;
  attempts: number;
  output: string | null;
  error: string | null;
  tokens: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunStepView {
  seq: number;
  kind: 'plan' | 'assign' | 'turn' | 'tool' | 'merge' | 'review' | 'budget' | 'note' | 'error' | 'finish';
  taskKey: string | null;
  agentId: string | null;
  summary: string;
  tokens: number;
  createdAt: string;
}

export interface RunSummaryView {
  id: string;
  teamId: string | null;
  conversationId: string;
  goal: string;
  mode: TeamMode | null;
  status: RunStatus;
  budgetTokens: number;
  spentTokens: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface RunView extends RunSummaryView {
  result: string | null;
  error: string | null;
  revisions: number;
  tasks: RunTaskView[];
  steps: RunStepView[];
  /** The team as it was asked to work: who is who on the graph. */
  members: TeamMemberView[];
  /** Proposals the run made, waiting for the person on its conversation's cards. */
  proposals: number;
}
