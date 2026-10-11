import type { AgentMode, Principal } from '@milyonuse/contracts';
import type { RunSource } from '@milyonuse/memory';
import type { ToolRisk } from '@milyonuse/security';
import { z } from 'zod';
import type { AgentToolSpec } from '../agent-model.port.js';

/**
 * What a tool is, and what it may answer (ported from App-Milyonus
 * `modules/agent/tools/tool.ts`).
 *
 * Every tool reads, or proposes: it answers with data the person may see, or
 * hands a candidate to a pipeline that decides — memory (Phase 2), and from
 * Phase 3 changes the person confirms. Nothing the model says is written
 * directly (D-11): a tool that is not `safe` is never run by the turn itself;
 * the RiskEngine decides whether it runs now, as a recorded action, or waits
 * on a card for the person (modules/agent/actions).
 */

export interface ToolContext {
  principal: Principal;
  conversationId: string;
  /** The turn: the id of the person's message that started it — what its memory is derived under. */
  runId: string;
  /** The person's IANA time zone for this turn — a time they give is read in it; UTC when unknown. */
  timeZone: string;
  /** How the person asked the agent to work this turn; a confirmed action runs as `ask`. */
  mode?: AgentMode | undefined;
  /** The action this run belongs to, when a confirmed proposal is running it. */
  actionId?: string | undefined;
}

/** What a proposal card shows: what will happen, in the person's terms. */
export interface ActionPreview {
  title: string;
  /** One line under the title: who, where, when. */
  summary?: string | undefined;
  /** Labelled values: To, Subject, When … */
  fields?: { label: string; value: string }[] | undefined;
  /** A longer body — the message to be sent, the code to be run. */
  body?: string | undefined;
  /** For many items: the first few, as rows. */
  table?: { columns: string[]; rows: string[][] } | undefined;
  warnings?: string[] | undefined;
}

/** The call that undoes a completed one — proposed, like any other. */
export interface InverseCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolOutcome {
  kind: 'data';
  data: unknown;
  /** Where a read's answer came from, in words, when the tool's own summary is too general. */
  from?: string;
  /**
   * What the tool read from outside the conversation — a document, a page, a
   * mail. The turn is tainted by it: whatever it proposes to memory is derived
   * from these, and no more trusted than they are (D-12).
   */
  reads?: RunSource[];
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
  /** What running it risks (D-11). Omitted: `safe` — it only reads, or writes only into the person's own space. */
  risk?: ToolRisk;
  /** Whether what it does can be taken back. Omitted: true. */
  reversible?: boolean;
  /** The connection a tool of a connected app goes through. */
  connectionId?: string;
  /** A connected app's own JSON Schema for its arguments, shown to the model as given; `schema` still validates. */
  parameters?: Record<string, unknown>;
  /**
   * Runs it. For a tool that is not `safe`, called only by the action
   * executor, after the RiskEngine and — unless it ran as it was made — a
   * person's confirmation.
   */
  run(context: ToolContext, args: z.infer<S>): Promise<ToolOutcome>;
  /** What the card shows before anyone confirms. Omitted: a generic card of the arguments. */
  preview?(context: ToolContext, args: z.infer<S>): Promise<ActionPreview> | ActionPreview;
  /** The pieces a large call is run in, slice by slice; each run by `runItem`. */
  items?(args: z.infer<S>): unknown[];
  runItem?(context: ToolContext, args: z.infer<S>, item: unknown): Promise<unknown>;
  /** The call that undoes this one once it completed, or null when nothing can (an email sent stays sent). */
  inverse?(args: z.infer<S>, result: unknown): InverseCall | null;
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
    parameters: definition.parameters ?? toToolSchema(definition.schema),
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
