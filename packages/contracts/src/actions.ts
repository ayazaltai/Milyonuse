import { z } from 'zod';

/**
 * Actions (Phase 3): a tool call that changes something outside the
 * conversation, as the person sees it — proposed on a card and confirmed, or
 * run as it was made in auto mode and recorded the same way. The rules live in
 * 0009_actions and the RiskEngine (D-11).
 */

export const AGENT_ACTION_STATUSES = ['proposed', 'running', 'completed', 'failed', 'discarded', 'expired'] as const;
export type AgentActionStatus = (typeof AGENT_ACTION_STATUSES)[number];

export type AgentActionRisk = 'safe' | 'caution' | 'danger';

export interface AgentActionPreview {
  title: string;
  summary?: string | undefined;
  fields?: { label: string; value: string }[] | undefined;
  body?: string | undefined;
  table?: { columns: string[]; rows: string[][] } | undefined;
  warnings?: string[] | undefined;
}

export interface AgentActionView {
  id: string;
  conversationId: string;
  tool: string;
  /** The app it goes through, when it is a connected app's tool. */
  connection: { id: string; name: string; provider: string } | null;
  preview: AgentActionPreview;
  risk: AgentActionRisk;
  reversible: boolean;
  /** Why it waits for a person — or why it ran as it was made. */
  reason: string;
  status: AgentActionStatus;
  autoConfirmed: boolean;
  itemCount: number;
  processed: number;
  succeeded: number;
  failed: number;
  /** Interrupted mid-way: reported, never run a second time. */
  uncertain: number;
  result: Record<string, unknown> | null;
  error: string | null;
  /** The completed action this one undoes. */
  undoOf: string | null;
  /** Whether a completed action can be undone now (its tool has an inverse, and none was proposed yet). */
  undoable: boolean;
  createdAt: string;
  expiresAt: string;
  confirmedAt: string | null;
  finishedAt: string | null;
}

export const agentActionListQuerySchema = z.object({
  status: z.enum(AGENT_ACTION_STATUSES).optional(),
  conversationId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
});
export type AgentActionListQuery = z.infer<typeof agentActionListQuerySchema>;

// ─────────────────────────────────────────────────────────────── connections

export const CONNECTION_STATUSES = ['active', 'disabled', 'error', 'revoked'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** An app the person can connect, as its card shows it. */
export interface ConnectionAppView {
  provider: string;
  name: string;
  description: string;
  /** How it connects: an MCP server, or an app's own API with OAuth. */
  transport: 'mcp_http' | 'oauth_api';
  /** Whether this deployment can connect it now (its OAuth client is configured, or it needs none). */
  available: boolean;
  /** A custom MCP server: the person gives its address. */
  custom: boolean;
  scopes: string[];
}

export interface ConnectionToolView {
  name: string;
  title: string;
  description: string;
  risk: AgentActionRisk;
  reversible: boolean;
}

export interface ConnectionView {
  id: string;
  provider: string;
  name: string;
  transport: 'mcp_http' | 'oauth_api';
  serverUrl: string | null;
  status: ConnectionStatus;
  scopes: string[];
  accountLabel: string | null;
  tools: ConnectionToolView[];
  lastError: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export const connectionStartSchema = z.object({
  provider: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  /** A custom MCP server's address (https). */
  serverUrl: z.string().trim().url().max(500).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  /** A static bearer token for a custom server that takes one instead of OAuth. */
  token: z.string().trim().min(8).max(4000).optional(),
});
export type ConnectionStartInput = z.infer<typeof connectionStartSchema>;

/** Where the browser goes next: the app's consent page, or nowhere — connected already. */
export interface ConnectionStartResult {
  authorizeUrl: string | null;
  connection: ConnectionView | null;
}

export const connectionUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.enabled !== undefined, 'Nothing to change');
export type ConnectionUpdateInput = z.infer<typeof connectionUpdateSchema>;

export const connectionCallbackSchema = z.object({
  state: z.string().min(16).max(200),
  code: z.string().min(1).max(4000).optional(),
  error: z.string().max(200).optional(),
});
