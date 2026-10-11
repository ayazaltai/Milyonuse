import { Injectable } from '@nestjs/common';
import {
  type AgentDefinition,
  type AgentDefinitionPatch,
  ErrorCode,
  type Principal,
  STUDIO_LIMITS,
  type StudioAgentCreate,
  type StudioAgentUpdate,
  type StudioAgentVersionView,
  type StudioAgentView,
  type StudioTemplateView,
  type StudioToolOption,
  agentDefinitionSchema,
} from '@milyonuse/contracts';
import { AGENT_TEMPLATES, type AgentTemplate, agentTemplate } from '@milyonuse/skills';
import type pg from 'pg';
import { AppError } from '../../common/app-error.js';
import { AgentToolbox } from '../agent/agent.toolbox.js';
import { CORE_TOOLS } from '../agent/profile.js';
import { APPS } from '../connections/catalogue.js';
import { AuditService } from '../tenancy/audit.service.js';
import { rethrowDatabaseError } from '../tenancy/database-error.js';
import { SkillsService } from './skills.service.js';
import { StudioStore, agentView, definitionOf, versionView } from './studio.store.js';

/**
 * The agent studio (F4 §1): a person's own agents, from a template or from
 * nothing. Editing what an agent is — persona, instructions, tier, tools,
 * memory, autonomy, budget, skills — writes a new version; the old one stays
 * as it was, and every answer names the version that wrote it (acceptance 1).
 * Name, face and role title change in place. An agent is archived, never
 * deleted: its conversations keep their history.
 */
@Injectable()
export class StudioService {
  constructor(
    private readonly store: StudioStore,
    private readonly skills: SkillsService,
    private readonly toolbox: AgentToolbox,
    private readonly audit: AuditService,
  ) {}

  // ─────────────────────────────────────────────────────────────── reading

  async list(principal: Principal, includeArchived: boolean): Promise<StudioAgentView[]> {
    return this.store.run(principal, async (client) => {
      const out: StudioAgentView[] = [];
      for (const row of await this.store.agents(client, includeArchived)) {
        out.push(agentView(row, await this.store.version(client, row.current_version_id)));
      }
      return out;
    });
  }

  async get(principal: Principal, id: string): Promise<StudioAgentView> {
    return this.store.run(principal, (client) => this.viewIn(client, id));
  }

  async versions(principal: Principal, id: string): Promise<StudioAgentVersionView[]> {
    return this.store.run(principal, async (client) => {
      await this.store.agent(client, id);
      return (await this.store.versions(client, id)).map(versionView);
    });
  }

  templates(locale: 'en' | 'tr'): StudioTemplateView[] {
    return AGENT_TEMPLATES.map((t) => ({
      id: t.id,
      avatar: t.avatar,
      name: t.name[locale],
      roleTitle: t.roleTitle[locale],
      description: t.description[locale],
      definition: definitionOfTemplate(t, []),
      skillNames: t.skills,
    }));
  }

  /** What an agent may be allowed beyond the core: everyone's tools, and each kind of connected app. */
  toolOptions(): StudioToolOption[] {
    const tools: StudioToolOption[] = this.toolbox.tools
      .filter((t) => !CORE_TOOLS.has(t.name))
      .map((t) => ({ name: t.name, summary: t.summary, risk: t.risk ?? 'safe', provider: null }));
    const apps: StudioToolOption[] = APPS.map((a) => ({
      name: `connection:${a.provider}`,
      summary: a.name,
      risk: 'caution',
      provider: a.provider,
    }));
    return [...tools, ...apps];
  }

  // ─────────────────────────────────────────────────────────────── writing

  async create(principal: Principal, input: StudioAgentCreate): Promise<StudioAgentView> {
    const template = input.template ? agentTemplate(input.template) : undefined;
    if (input.template && !template) throw AppError.notFound('Template');
    const id = await this.store.run(principal, async (client) => {
      if ((await this.store.countAgents(client)) >= STUDIO_LIMITS.agents) {
        throw new AppError(ErrorCode.CONFLICT, `You can keep up to ${STUDIO_LIMITS.agents} agents. Archive one to make room.`);
      }
      // A template's skills come into the person's library with it.
      const skillIds: string[] = [];
      for (const name of template?.skills ?? []) skillIds.push(await this.skills.ensureBundled(client, principal, name));
      const base = template ? definitionOfTemplate(template, skillIds) : agentDefinitionSchema.parse({});
      const definition = await this.checked(client, { ...base, ...stripUndefined(input.definition ?? {}) });
      try {
        const created = await this.store.createAgent(
          client,
          principal,
          {
            name: input.name ?? template?.name[input.locale] ?? 'My agent',
            avatar: input.avatar ?? template?.avatar ?? '✦',
            roleTitle: input.roleTitle ?? template?.roleTitle[input.locale] ?? '',
            template: template?.id ?? null,
          },
          definition,
        );
        await this.note(client, principal, 'agent.created', created, { template: template?.id ?? null });
        return created;
      } catch (error) {
        rethrowDatabaseError(error);
      }
    });
    return this.get(principal, id);
  }

  /** Identity in place; anything the agent *is* as a new version — only when something actually changed. */
  async update(principal: Principal, id: string, input: StudioAgentUpdate): Promise<StudioAgentView> {
    return this.store.run(principal, async (client) => {
      const agent = await this.store.agent(client, id, true);
      if (agent.archived_at) throw new AppError(ErrorCode.CONFLICT, 'Restore this agent before changing it.');
      if (input.name !== undefined || input.avatar !== undefined || input.roleTitle !== undefined) {
        await this.store.updateIdentity(client, id, input);
      }
      if (input.definition) {
        const current = definitionOf(await this.store.version(client, agent.current_version_id));
        const next = await this.checked(client, { ...current, ...stripUndefined(input.definition) });
        if (!sameDefinition(current, next)) {
          try {
            const versionId = await this.store.addVersion(client, principal, id, next, input.note ?? null);
            await this.note(client, principal, 'agent.versioned', id, { versionId });
          } catch (error) {
            rethrowDatabaseError(error);
          }
        }
      }
      return this.viewIn(client, id);
    });
  }

  async setArchived(principal: Principal, id: string, archived: boolean): Promise<StudioAgentView> {
    return this.store.run(principal, async (client) => {
      await this.store.agent(client, id, true);
      await this.store.setArchived(client, id, archived);
      await this.note(client, principal, archived ? 'agent.archived' : 'agent.restored', id);
      return this.viewIn(client, id);
    });
  }

  // ─────────────────────────────────────────────────────────────── helpers

  private async viewIn(client: pg.PoolClient, id: string): Promise<StudioAgentView> {
    const row = await this.store.agent(client, id);
    return agentView(row, await this.store.version(client, row.current_version_id));
  }

  /** A definition the product can honour: known tools only, the person's own skills only, no repeats. */
  private async checked(client: pg.PoolClient, definition: AgentDefinition): Promise<AgentDefinition> {
    const parsed = agentDefinitionSchema.parse(definition);
    const known = new Set(this.toolOptions().map((t) => t.name));
    const unknown = parsed.tools.filter((t) => !known.has(t) && !CORE_TOOLS.has(t));
    if (unknown.length > 0) throw new AppError(ErrorCode.VALIDATION_FAILED, `Unknown tools: ${unknown.slice(0, 5).join(', ')}.`);
    const tools = [...new Set(parsed.tools.filter((t) => !CORE_TOOLS.has(t)))].sort();
    const skills = [...new Set(parsed.skills)];
    await this.skills.checkOwn(client, skills);
    return { ...parsed, tools, skills };
  }

  private note(client: pg.PoolClient, principal: Principal, action: string, agentId: string, after?: Record<string, unknown>): Promise<void> {
    return this.audit.record(client, {
      organizationId: principal.organizationId,
      actorMemberId: principal.memberId,
      action,
      resourceType: 'agent',
      resourceId: agentId,
      after,
    });
  }
}

function definitionOfTemplate(t: AgentTemplate, skillIds: string[]): AgentDefinition {
  return {
    persona: t.persona,
    instructions: t.instructions,
    modelTier: t.modelTier,
    tools: [...t.tools].sort(),
    memoryScope: t.memoryScope,
    autonomy: t.autonomy,
    unattendedPolicy: 'safe_only',
    budgetTokens: t.budgetTokens,
    budgetSandboxMinutes: t.budgetSandboxMinutes,
    skills: skillIds,
  };
}

/** The fields a change names; one sent as undefined changes nothing. */
function stripUndefined(value: AgentDefinitionPatch): Partial<AgentDefinition> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<AgentDefinition>;
}

/** Whether two definitions say the same — tools and skills as sets — so saving an unchanged form writes no version. */
function sameDefinition(a: AgentDefinition, b: AgentDefinition): boolean {
  const canonical = (d: AgentDefinition) =>
    JSON.stringify(
      Object.entries({ ...d, tools: [...d.tools].sort(), skills: [...d.skills].sort() }).sort(([x], [y]) => x.localeCompare(y)),
    );
  return canonical(a) === canonical(b);
}
