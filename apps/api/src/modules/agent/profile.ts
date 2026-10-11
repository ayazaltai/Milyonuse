import type { AgentMode, AgentModelTier } from '@milyonuse/contracts';
import { ToolSet } from './agent.toolbox.js';
import { tierOf } from './models.js';
import type { AgentTool } from './tools/tool.js';

/**
 * A turn with one of the person's agents (Phase 4): the version that answers,
 * and how it shapes the turn — its model tier, the tools it may use, how far
 * it acts on its own, what a turn may spend, the memory it reads. A version
 * narrows what the product allows; it never widens it. The deployment's
 * ceilings, the RiskEngine and the rules of the prompt hold above every
 * agent.
 */

export interface AgentProfile {
  agentId: string;
  versionId: string;
  version: number;
  name: string;
  roleTitle: string;
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
  archived: boolean;
}

/** What a tool sees of the agent it runs for. */
export interface TurnAgent {
  id: string;
  versionId: string;
  memoryScope: 'user' | 'agent';
  /** Skills it may open, by id; null — the plain agent — any of the person's enabled ones. */
  skills: string[] | null;
  unattendedPolicy: 'safe_only' | 'trusted';
}

/**
 * Tools every agent has whatever its list says: reading what the person hands
 * over, memory (checked before it is kept), the time, laying data out, and
 * skills (approved before they are used). None of them reaches outside.
 */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  'read_document',
  'read_table',
  'memory_propose',
  'memory_search',
  'memory_forget',
  'user_recall',
  'current_time',
  'present',
  'skill_read',
  'skill_file',
  'skill_propose',
]);

/** The tools that need the sandbox; an agent with no sandbox minutes has none of them. */
const SANDBOX_TOOLS: ReadonlySet<string> = new Set(['code_run']);

export function turnAgentOf(profile: AgentProfile | null): TurnAgent | undefined {
  if (!profile) return undefined;
  return {
    id: profile.agentId,
    versionId: profile.versionId,
    memoryScope: profile.memoryScope,
    skills: profile.skills,
    unattendedPolicy: profile.unattendedPolicy,
  };
}

/** Whether an agent's list allows a tool: by name, or a connected app's by `connection:<provider>`. */
export function allows(profile: AgentProfile, tool: Pick<AgentTool, 'name' | 'provider'>): boolean {
  if (CORE_TOOLS.has(tool.name)) return true;
  if (SANDBOX_TOOLS.has(tool.name) && profile.budgetSandboxMinutes === 0) return false;
  if (tool.provider) return profile.tools.includes(`connection:${tool.provider}`);
  return profile.tools.includes(tool.name);
}

/** The person's tools as this agent has them. */
export function toolsetFor(toolset: ToolSet, profile: AgentProfile | null): ToolSet {
  if (!profile) return toolset;
  return new ToolSet(toolset.tools.filter((t) => allows(profile, t)));
}

/** The first offered model of the agent's tier; the conversation's own when none is. */
export function modelFor(offered: readonly string[], tier: AgentModelTier, fallback: string): string {
  return offered.find((id) => tierOf(id) === tier) ?? fallback;
}

/** An agent set to ask never works in auto mode, whatever the composer says; plan stays plan. */
export function modeFor(mode: AgentMode, profile: AgentProfile | null): AgentMode {
  return profile?.autonomy === 'ask' && mode === 'auto' ? 'ask' : mode;
}

/** What one turn may spend: the agent's budget, never above the deployment's ceiling. */
export function turnTokensFor(ceiling: number, profile: AgentProfile | null): number {
  return profile ? Math.min(ceiling, profile.budgetTokens) : ceiling;
}
