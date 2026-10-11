import { z } from 'zod';
import type { AgentModelTier } from './agent.js';
import { ulidSchema } from './primitives.js';

/**
 * The agent studio and skills (Phase 4): a person's own agents, each a series
 * of immutable versions, and the skills they use — procedural memory that a
 * learned skill earns by a passing replay and a person's approval. The rules
 * live in 0010_studio.
 */

export const STUDIO_LIMITS = {
  agents: 50,
  name: 60,
  roleTitle: 80,
  persona: 2000,
  instructions: 8000,
  tools: 100,
  skillsPerAgent: 50,
  budgetTokens: { min: 1000, max: 2_000_000 },
  budgetSandboxMinutes: { min: 0, max: 120 },
  skillContent: 50_000,
  skillFiles: 10,
  skillFileChars: 20_000,
  /** Enabled skills listed by name in the prompt's index (level 0). */
  skillIndex: 30,
} as const;

/** A tool by name, or a connected app's tools as `connection:<provider>`. */
const toolNameSchema = z.string().regex(/^(?:[a-z][a-z0-9_]{0,63}|connection:[a-z][a-z0-9_]{0,40})$/, 'a tool name or connection:<provider>');

/** What an agent is, field by field — no defaults, so a change names only what it changes. */
const definitionFields = {
  persona: z.string().trim().max(STUDIO_LIMITS.persona),
  instructions: z.string().trim().max(STUDIO_LIMITS.instructions),
  modelTier: z.enum(['fast', 'balanced', 'deep']),
  tools: z.array(toolNameSchema).max(STUDIO_LIMITS.tools),
  memoryScope: z.enum(['user', 'agent']),
  autonomy: z.enum(['ask', 'auto']),
  unattendedPolicy: z.enum(['safe_only', 'trusted']),
  budgetTokens: z.number().int().min(STUDIO_LIMITS.budgetTokens.min).max(STUDIO_LIMITS.budgetTokens.max),
  budgetSandboxMinutes: z.number().int().min(STUDIO_LIMITS.budgetSandboxMinutes.min).max(STUDIO_LIMITS.budgetSandboxMinutes.max),
  skills: z.array(ulidSchema).max(STUDIO_LIMITS.skillsPerAgent),
};

/** A whole definition: what an agent made from nothing starts as. */
export const agentDefinitionSchema = z.object({
  persona: definitionFields.persona.default(''),
  instructions: definitionFields.instructions.default(''),
  modelTier: definitionFields.modelTier.default('balanced'),
  tools: definitionFields.tools.default([]),
  memoryScope: definitionFields.memoryScope.default('user'),
  autonomy: definitionFields.autonomy.default('ask'),
  unattendedPolicy: definitionFields.unattendedPolicy.default('safe_only'),
  budgetTokens: definitionFields.budgetTokens.default(200_000),
  budgetSandboxMinutes: definitionFields.budgetSandboxMinutes.default(5),
  skills: definitionFields.skills.default([]),
});

/** Some fields of a definition: the rest stay as they are. */
export const agentDefinitionPatchSchema = z.object(definitionFields).partial();
export type AgentDefinitionPatch = z.infer<typeof agentDefinitionPatchSchema>;
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

const identity = {
  name: z.string().trim().min(1).max(STUDIO_LIMITS.name),
  avatar: z.string().trim().min(1).max(8),
  roleTitle: z.string().trim().max(STUDIO_LIMITS.roleTitle),
};

/** A new agent: from a template (its definition copied, then any field given here), or from nothing. */
export const studioAgentCreateSchema = z.object({
  template: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/).optional(),
  /** Which language a template's name and role title are taken in. */
  locale: z.enum(['en', 'tr']).default('en'),
  name: identity.name.optional(),
  avatar: identity.avatar.optional(),
  roleTitle: identity.roleTitle.optional(),
  definition: agentDefinitionPatchSchema.optional(),
});
export type StudioAgentCreate = z.infer<typeof studioAgentCreateSchema>;

/** A change: identity in place; any definition field is a new version, with an optional note. */
export const studioAgentUpdateSchema = z
  .object({
    name: identity.name.optional(),
    avatar: identity.avatar.optional(),
    roleTitle: identity.roleTitle.optional(),
    definition: agentDefinitionPatchSchema.optional(),
    note: z.string().trim().max(300).optional(),
  })
  .refine((v) => v.name !== undefined || v.avatar !== undefined || v.roleTitle !== undefined || v.definition !== undefined, {
    message: 'Nothing to change',
  });
export type StudioAgentUpdate = z.infer<typeof studioAgentUpdateSchema>;

export interface StudioAgentVersionView {
  id: string;
  version: number;
  persona: string;
  instructions: string;
  modelTier: AgentModelTier;
  tools: string[];
  memoryScope: 'user' | 'agent';
  autonomy: 'ask' | 'auto';
  unattendedPolicy: 'safe_only' | 'trusted';
  budgetTokens: number;
  budgetSandboxMinutes: number;
  skills: string[];
  note: string | null;
  createdAt: string;
}

export interface StudioAgentView {
  id: string;
  name: string;
  avatar: string;
  roleTitle: string;
  template: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  current: StudioAgentVersionView;
  /** Conversations held with it. */
  conversations: number;
}

export interface StudioTemplateView {
  id: string;
  avatar: string;
  name: string;
  roleTitle: string;
  description: string;
  definition: AgentDefinition;
  /** Bundled skills it brings, by name. */
  skillNames: string[];
}

/** A tool an agent may be allowed, as the editor lists it. */
export interface StudioToolOption {
  name: string;
  summary: string;
  risk: 'safe' | 'caution' | 'danger';
  /** Set for a connected app's tools, offered together as `connection:<provider>`. */
  provider: string | null;
}

// ──────────────────────────────────────────────────────────────── skills

export const SKILL_STATES = ['staging', 'active', 'rejected', 'revoked', 'superseded'] as const;
export type SkillState = (typeof SKILL_STATES)[number];
export type SkillVerdict = 'clean' | 'caution' | 'danger';

const skillFileSchema = z.object({
  path: z.string().min(1).max(120),
  content: z.string().max(STUDIO_LIMITS.skillFileChars),
});

/** A skill a person writes: the whole SKILL.md, files beside it; caution kept only when they insist. */
export const skillWriteSchema = z.object({
  content: z.string().min(1).max(STUDIO_LIMITS.skillContent),
  files: z.array(skillFileSchema).max(STUDIO_LIMITS.skillFiles).default([]),
  force: z.boolean().default(false),
});
export type SkillWrite = z.infer<typeof skillWriteSchema>;

export const skillBundledSchema = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/) });

export const skillUpdateSchema = z.object({ enabled: z.boolean() });

export const skillDecisionSchema = z.object({ reason: z.string().trim().max(500).optional() });

export interface SkillFindingView {
  signal: string;
  verdict: SkillVerdict;
  detail: string;
}

export interface SkillRunView {
  id: string;
  passed: boolean;
  score: number | null;
  evaluator: 'rules' | 'rules+model';
  verdict: string;
  createdAt: string;
}

export interface SkillVersionView {
  id: string;
  version: number;
  state: SkillState;
  description: string;
  content: string;
  files: { path: string; chars: number }[];
  scanVerdict: SkillVerdict;
  findings: SkillFindingView[];
  /** Where a learned skill came from. */
  sourceConversationId: string | null;
  task: string | null;
  derivedFrom: string[];
  stateReason: string | null;
  approvedAt: string | null;
  /** Approved by a trusted policy rather than a person. */
  approvedByPolicy: boolean;
  createdAt: string;
  decidedAt: string | null;
  runs: SkillRunView[];
}

export interface SkillSummaryView {
  id: string;
  name: string;
  source: 'bundled' | 'user' | 'learned';
  enabled: boolean;
  /** The version in use, if any is active. */
  active: { id: string; version: number; description: string } | null;
  /** The newest version waiting for a replay or a decision. */
  staging: { id: string; version: number; description: string; replayed: boolean; passed: boolean | null } | null;
  title: { en: string; tr: string } | null;
  updatedAt: string;
}

export interface SkillDetailView extends SkillSummaryView {
  versions: SkillVersionView[];
}

export interface SkillCatalogueEntry {
  name: string;
  title: { en: string; tr: string };
  summary: { en: string; tr: string };
  category: string;
  requiresTools: string[];
  /** Already in the person's library. */
  added: boolean;
}
