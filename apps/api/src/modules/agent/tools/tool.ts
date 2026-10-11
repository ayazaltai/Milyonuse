import type { Principal } from '@milyonuse/contracts';
import { z } from 'zod';
import type { AgentToolSpec } from '../agent-model.port.js';

/**
 * What a tool is, and what it may answer (ported from App-Milyonus
 * `modules/agent/tools/tool.ts`).
 *
 * In Phase 1 every tool reads: it answers with data the person may see and
 * changes nothing. Tools that change something arrive in Phase 3, and only as
 * proposals the person confirms — never as a write the model makes directly
 * (D-11).
 */

export interface ToolContext {
  principal: Principal;
  conversationId: string;
  /** The person's IANA time zone for this turn — a time they give is read in it; UTC when unknown. */
  timeZone: string;
}

export interface ToolOutcome {
  kind: 'data';
  data: unknown;
  /** Where a read's answer came from, in words, when the tool's own summary is too general. */
  from?: string;
}

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** The step in words, for the thread: "Read the attachment". */
  summary: string;
  /**
   * Whether the answer is a *source* — data `present` may lay out — or only
   * something the model reads (the time, a card it drew).
   */
  source: boolean;
  run(context: ToolContext, args: z.infer<S>): Promise<ToolOutcome>;
}

/** Declares a tool with its argument type inferred from its schema. */
export function tool<S extends z.ZodType>(definition: AgentTool<S>): AgentTool {
  return definition as unknown as AgentTool;
}

/**
 * A refusal the model should hear and act on — an id that is not there, an
 * argument out of range. Answered to the model as `{ "error": … }`, never
 * thrown past the turn.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/** A zod schema as the JSON Schema a model router accepts: no dialect marker, no machine-sized noise. */
export function toToolSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete json['$schema'];
  return clean(json) as Record<string, unknown>;
}

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    // A date-time's regular expression is a kilobyte the format already says.
    if (key === 'pattern' && (node as Record<string, unknown>)['format'] === 'date-time') continue;
    // "An integer between -2^53 and 2^53" is what an integer is.
    if ((key === 'minimum' || key === 'maximum') && Math.abs(value as number) >= Number.MAX_SAFE_INTEGER) continue;
    out[key] = clean(value);
  }
  return out;
}

export function specOf(definition: AgentTool): AgentToolSpec {
  return {
    name: definition.name,
    description: definition.description,
    parameters: toToolSchema(definition.schema),
  };
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** Validation issues, as the model can act on them. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'arguments'}: ${issue.message}`)
    .join('; ');
}
