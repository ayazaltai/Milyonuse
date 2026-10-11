import { z } from 'zod';
import { ulidSchema } from './primitives.js';

/**
 * Verified memory (Phase 2): what the agent remembers, where each memory came
 * from, how much it is trusted now, and what the person can do about it. The
 * vocabulary is 0007_memory's; the rules live there and in @milyonuse/memory.
 */

export const MEMORY_TIERS = ['T0', 'T1', 'T2', 'T3', 'T4'] as const;
export type MemoryTier = (typeof MEMORY_TIERS)[number];

export const MEMORY_STATES = ['pending', 'active', 'demoted', 'rejected', 'revoked', 'expired', 't0_staged'] as const;
export type MemoryStateName = (typeof MEMORY_STATES)[number];

export const MEMORY_SOURCE_KINDS = ['operator', 'user_direct', 'agent_observed', 'third_party', 'subagent', 'unknown'] as const;
export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];

export const MEMORY_LIMITS = {
  /** Characters in one memory (0007). */
  contentChars: 2000,
  /** Memories a list answers at once. */
  page: 100,
} as const;

// ────────────────────────────────────────────────────────────────── requests

/** The person adds a memory themselves: their own words, T1. */
export const memoryCreateSchema = z.object({
  content: z.string().trim().min(1, 'Write what to remember').max(MEMORY_LIMITS.contentChars),
});
export type MemoryCreateInput = z.infer<typeof memoryCreateSchema>;

export const memoryListQuerySchema = z.object({
  state: z.enum(MEMORY_STATES).optional(),
  tier: z.enum(MEMORY_TIERS).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  /** Only what the agent asked to forget, waiting for the person. */
  forget: z.enum(['requested']).optional(),
});
export type MemoryListQuery = z.infer<typeof memoryListQuerySchema>;

/** Everything from one source, and everything built on it, revoked at once. */
export const memoryRevokeSourceSchema = z.object({
  sourceUri: z.string().trim().min(1).max(2000),
  reason: z.string().trim().max(500).default('Source withdrawn by the person'),
});
export type MemoryRevokeSourceInput = z.infer<typeof memoryRevokeSourceSchema>;

export const memoryForgetSchema = z.object({
  reason: z.string().trim().max(500).default('Forgotten at the person’s request'),
});

/** An operator's signed T0, staged for one organization (the signature is the authentication). */
export const operatorStageSchema = z.object({
  organizationId: ulidSchema,
  content: z.string().trim().min(1).max(MEMORY_LIMITS.contentChars),
  signature: z.string().min(1).max(200),
});
export type OperatorStageInput = z.infer<typeof operatorStageSchema>;

export const operatorActivateSchema = z.object({
  organizationId: ulidSchema,
  itemId: ulidSchema,
  signature: z.string().min(1).max(200),
});
export type OperatorActivateInput = z.infer<typeof operatorActivateSchema>;

// ───────────────────────────────────────────────────────────────────── views

export interface MemoryItemView {
  id: string;
  content: string;
  tier: MemoryTier;
  state: MemoryStateName;
  sourceKind: MemorySourceKind;
  sourceUri: string | null;
  actor: string;
  sensitivity: 'normal' | 'sensitive';
  /** Trust now, 0–1: the ceiling, halved every half-life since it was last reaffirmed. */
  trust: number;
  trustCeiling: number;
  confirmations: number;
  reaffirmCount: number;
  /** An operator's T0: the organization's, not the person's. */
  operator: boolean;
  /** Set when it is one agent's own memory (0011), not every agent's of the person's. */
  agentId: string | null;
  stateReason: string | null;
  verdict: string | null;
  createdAt: string;
  verifiedAt: string | null;
  expiresAt: string | null;
  demotedAt: string | null;
  /** The agent asked for it to be forgotten; the person decides. */
  forgetRequestedAt: string | null;
  forgetReason: string | null;
  /** A memory consolidation thinks it contradicts. */
  flaggedWith: string | null;
}

export interface MemoryLedgerEntryView {
  seq: number;
  action: string;
  detail: Record<string, unknown>;
  entryHash: string;
  createdAt: string;
}

/** "Why do you know this?" — the memory, its evidence, its history and what hangs on it. */
export interface MemoryDetailView {
  item: MemoryItemView;
  ledger: MemoryLedgerEntryView[];
  confirmations: { sourceKind: MemorySourceKind; sourceUri: string | null; createdAt: string }[];
  derivedFrom: { sourceUris: string[]; memories: { id: string; content: string }[] };
  /** Memories built on this one — what a revocation would also take. */
  derivatives: { id: string; content: string; state: MemoryStateName }[];
}

export interface MemoryListView {
  items: MemoryItemView[];
  counts: Record<MemoryStateName, number>;
}

/** What revoking a source would take, before anyone does it. */
export interface MemoryRevocationPreview {
  sourceUri: string;
  items: { id: string; content: string; state: MemoryStateName }[];
}

export interface MemoryLedgerStatus {
  intact: boolean;
  /** Entries checked. */
  checked: number;
  /** The first entry that does not hold, when one does not. */
  brokenSeq: number | null;
}
