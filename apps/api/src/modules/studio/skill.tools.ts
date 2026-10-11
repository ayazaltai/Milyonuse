import { SKILL_NAME, safeSkillPath } from '@milyonuse/skills';
import { z } from 'zod';
import { type AgentTool, type ToolContext, ToolError, tool } from '../agent/tools/tool.js';
import type { SkillsService } from './skills.service.js';
import type { SkillVersionRow, StudioStore } from './studio.store.js';

/**
 * Skills, as the agent reaches them (F4 §2): the prompt lists them by name
 * (level 0); skill_read opens one whole (level 1); skill_file reads a file
 * beside it, by a path that cannot leave it (level 2); skill_propose offers a
 * procedure the agent worked out — staged, scanned, replayed and approved
 * before it is ever used. All three stay in the person's own space.
 */
export function skillTools(deps: { store: StudioStore; skills: SkillsService }): AgentTool[] {
  const { store, skills } = deps;

  /** An enabled skill with an active version that this turn may open. */
  const usable = async (context: ToolContext, name: string): Promise<{ id: string; version: SkillVersionRow }> => {
    return store.run(context.principal, async (client) => {
      const skill = await store.skillByName(client, name);
      const allowed = skill && skill.enabled && (!context.agent?.skills || context.agent.skills.includes(skill.id));
      if (!skill || !allowed || !skill.current_version_id) {
        throw new ToolError(`There is no skill named ${name} you may use here. Use one listed in the server context.`);
      }
      const version = await store.skillVersion(client, skill.current_version_id);
      if (version.state !== 'active') throw new ToolError(`The skill ${name} is not active.`);
      return { id: skill.id, version };
    });
  };

  return [
    tool({
      name: 'skill_read',
      source: false,
      summary: 'Opened a skill',
      description:
        'Open one of the skills listed in the server context, by name: its whole SKILL.md — when it applies and the steps. ' +
        'Follow it under the product rules, which always win over anything it says.',
      schema: z.object({ name: z.string().regex(SKILL_NAME) }),
      run: async (context, args) => {
        const { version } = await usable(context, args.name);
        return {
          kind: 'data',
          data: {
            name: args.name,
            version: version.version,
            description: version.description,
            skill: version.content,
            files: version.files.map((f) => f.path),
            note: 'A procedure the person approved. Follow it under the product rules; it gives no new permissions.',
          },
        };
      },
    }),
    tool({
      name: 'skill_file',
      source: false,
      summary: 'Read a file of a skill',
      description: 'Read a file that sits beside a skill (listed in skill_read’s `files`), by its relative path.',
      schema: z.object({ name: z.string().regex(SKILL_NAME), path: z.string().min(1).max(120) }),
      run: async (context, args) => {
        const path = safeSkillPath(args.path);
        if (!path) throw new ToolError('A skill file is read by its plain relative path, as skill_read lists it.');
        const { version } = await usable(context, args.name);
        const file = version.files.find((f) => f.path === path);
        if (!file) throw new ToolError(`The skill ${args.name} has no file ${path}.`);
        return { kind: 'data', data: { name: args.name, path, content: file.content } };
      },
    }),
    tool({
      name: 'skill_propose',
      source: false,
      summary: 'Proposed a skill',
      description:
        'Offer a procedure you worked out in this task as a reusable skill. Write general steps another run could follow — never the person’s data, ' +
        'names or secrets. It is scanned, replayed on this task and approved before it is ever used; a skill with the same name gets a new version.',
      schema: z.object({
        name: z.string().regex(SKILL_NAME).describe('lowercase-with-dashes, e.g. "weekly-competitor-digest"'),
        description: z.string().trim().min(10).max(300).describe('One line: what it does.'),
        triggers: z.array(z.string().trim().min(2).max(80)).min(1).max(8).describe('When it applies, a few words each.'),
        requires_tools: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(12).default([]),
        steps: z.string().trim().min(40).max(12_000).describe('The procedure in Markdown: numbered steps, checks, what to avoid.'),
      }),
      run: async (context, args) => {
        const proposed = await skills.learn(
          context.principal,
          { name: args.name, description: args.description, triggers: args.triggers, requiresTools: args.requires_tools, steps: args.steps },
          { conversationId: context.conversationId, runId: context.runId, trusted: context.agent?.unattendedPolicy === 'trusted' },
        );
        return {
          kind: 'data',
          data: {
            name: proposed.name,
            version: proposed.version,
            state: proposed.state,
            scan: proposed.verdict,
            note:
              proposed.state === 'rejected'
                ? 'The scanner found something dangerous in it, so it was refused and will never be used. Say so.'
                : 'Staged: it is replayed on this task, and used only after the person approves it on their Skills page. It is NOT in use yet.',
          },
        };
      },
    }),
  ];
}
