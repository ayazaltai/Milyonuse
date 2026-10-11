import { Injectable } from '@nestjs/common';
import type { Principal } from '@milyonuse/contracts';
import { AppError } from '../../common/app-error.js';
import { AppLogger } from '../../common/logging/logger.js';
import type { AgentToolSpec } from './agent-model.port.js';
import { MemoryService } from '../memory/memory.service.js';
import { AgentStore } from './agent.store.js';
import { attachmentTools } from './tools/attachment.tools.js';
import { memoryTools } from './tools/memory.tools.js';
import { presentTool } from './tools/present.tool.js';
import { timeTool } from './tools/time.tool.js';
import { type AgentTool, type ToolContext, ToolError, type ToolOutcome, describeIssues, specOf } from './tools/tool.js';

/**
 * Every tool the agent has, in one place: their schemas as the model sees
 * them, and their arguments parsed and validated here — never trusted as the
 * model wrote them (ported from App-Milyonus `modules/agent/agent.toolbox.ts`).
 *
 * Some tools are everyone's (reading an attachment, memory, the web); others
 * are a person's own — the apps they connected (F3). A turn works with the
 * tool set of the person it runs for, read once at its start; a confirmed
 * proposal finds its tool in the set the person has *then*, so a connection
 * removed in between fails the proposal rather than reaching an app that is
 * no longer theirs.
 *
 * A refusal the model can act on — an invented id, an argument out of range —
 * is answered to it as `{ "error": … }`, and the model corrects itself or
 * asks the person. Only a fault of the system is logged as one.
 */

/** Where a person's own tools come from: a module that has some registers here. */
export type ToolSource = (principal: Principal) => Promise<AgentTool[]>;

export type Prepared = { kind: 'ready'; tool: AgentTool; args: Record<string, unknown> } | { kind: 'error'; message: string };

export class ToolSet {
  private readonly byName: ReadonlyMap<string, AgentTool>;

  constructor(readonly tools: readonly AgentTool[]) {
    this.byName = new Map(tools.map((t) => [t.name, t]));
  }

  get(name: string): AgentTool | undefined {
    return this.byName.get(name);
  }

  specs(): AgentToolSpec[] {
    return this.tools.map(specOf);
  }

  isSource(name: string): boolean {
    return this.byName.get(name)?.source ?? false;
  }

  summaries(): ReadonlyMap<string, string> {
    return new Map(this.tools.map((t) => [t.name, t.summary]));
  }

  /** Finds the tool and parses its arguments — nothing runs. */
  prepare(name: string, rawArguments: string | Record<string, unknown>): Prepared {
    const found = this.byName.get(name);
    if (!found) return { kind: 'error', message: `There is no tool named ${name}.` };
    let args: unknown;
    if (typeof rawArguments === 'string') {
      try {
        args = rawArguments.trim() === '' ? {} : JSON.parse(rawArguments);
      } catch {
        return { kind: 'error', message: 'The arguments were not valid JSON.' };
      }
    } else {
      args = rawArguments;
    }
    const parsed = found.schema.safeParse(args);
    if (!parsed.success) return { kind: 'error', message: `Invalid arguments — ${describeIssues(parsed.error)}` };
    return { kind: 'ready', tool: found, args: parsed.data as Record<string, unknown> };
  }
}

@Injectable()
export class AgentToolbox {
  /** The tools everyone has. */
  readonly tools: AgentTool[];
  private common: ToolSet;
  private readonly sources: ToolSource[] = [];

  constructor(
    store: AgentStore,
    memory: MemoryService,
    private readonly logger: AppLogger,
  ) {
    this.tools = [...attachmentTools(store), ...memoryTools(memory), timeTool(), presentTool(store)];
    this.common = new ToolSet(this.tools);
  }

  /** A module adds tools everyone has (the web, files, the sandbox). */
  add(tools: AgentTool[]): void {
    for (const t of tools) {
      if (this.tools.some((existing) => existing.name === t.name)) throw new Error(`Tool ${t.name} is registered twice`);
      this.tools.push(t);
    }
    this.common = new ToolSet(this.tools);
  }

  /** A module adds a person's own tools (their connected apps). */
  addSource(source: ToolSource): void {
    this.sources.push(source);
  }

  /** The tools a person has now: everyone's, and their own. */
  async forPrincipal(principal: Principal): Promise<ToolSet> {
    if (this.sources.length === 0) return this.common;
    const own: AgentTool[] = [];
    for (const source of this.sources) {
      try {
        own.push(...(await source(principal)));
      } catch (error) {
        // A connection that cannot be listed costs its own tools, not the turn.
        this.logger.warn('agent tool source failed', { err: error instanceof Error ? error.message : String(error) });
      }
    }
    const names = new Set(this.tools.map((t) => t.name));
    return new ToolSet([...this.tools, ...own.filter((t) => !names.has(t.name))]);
  }

  /** Everyone's tools — what a page shows of the steps' names. */
  specs(): AgentToolSpec[] {
    return this.common.specs();
  }

  isSource(name: string): boolean {
    return this.common.isSource(name) || name.startsWith('mcp_');
  }

  summaries(): ReadonlyMap<string, string> {
    return this.common.summaries();
  }

  /** Runs one of everyone's tools directly — reads and the person's own space only. */
  async run(name: string, rawArguments: string, context: ToolContext): Promise<ToolOutcome | { kind: 'error'; message: string }> {
    const prepared = this.common.prepare(name, rawArguments);
    if (prepared.kind === 'error') return prepared;
    return this.execute(prepared.tool, prepared.args, context);
  }

  /** Runs a prepared tool, answering a refusal the model can act on rather than throwing. */
  async execute(tool: AgentTool, args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome | { kind: 'error'; message: string }> {
    try {
      return await tool.run(context, args);
    } catch (error) {
      if (error instanceof ToolError || error instanceof AppError) return { kind: 'error', message: error.message };
      this.logger.error('agent tool failed', {
        tool: tool.name,
        err: error instanceof Error ? error.message : String(error),
      });
      return { kind: 'error', message: 'The tool failed unexpectedly. Nothing was changed.' };
    }
  }
}
