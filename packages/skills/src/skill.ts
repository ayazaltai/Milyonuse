import { FrontmatterError, type YamlValue, parseYaml, renderYaml } from './frontmatter.js';

/**
 * A skill: procedural memory, as a SKILL.md — YAML frontmatter and a Markdown
 * body (ported from Agent 5.5 `skills/model.py`; agentskills.io-compatible,
 * reading Agent 5.5's `metadata.milyonusagentskill` namespace and its older
 * `metadata.milyonus` alike).
 *
 * Three levels of detail, so the model spends tokens only on what it needs:
 * level 0 is the name and description in the prompt's index; level 1 the
 * whole SKILL.md; level 2 a file beside it, by a path that cannot leave it.
 */

export interface SkillMeta {
  name: string;
  description: string;
  version: string;
  /** When the skill applies, in a few words each: "a cold email", "a CSV to clean". */
  triggers: string[];
  /** Tools the skill relies on: code_run, web_fetch … */
  requiresTools: string[];
  tags: string[];
  category: string;
  provenance: 'bundled' | 'user' | 'learned';
}

export interface Skill {
  meta: SkillMeta;
  body: string;
}

export interface SkillFile {
  path: string;
  content: string;
}

export class SkillParseError extends Error {
  override name = 'SkillParseError';
}

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,63}$/;

function strings(value: YamlValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, 30) : [];
}

export function parseSkill(text: string): Skill {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) throw new SkillParseError('A SKILL.md starts with YAML frontmatter (---).');
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) throw new SkillParseError('The frontmatter is not closed (---).');
  let raw: { [key: string]: YamlValue };
  try {
    raw = parseYaml(normalized.slice(4, end));
  } catch (error) {
    throw new SkillParseError(error instanceof FrontmatterError ? `Frontmatter: ${error.message}` : 'Frontmatter could not be read.');
  }
  const body = normalized.slice(end + 4).replace(/^[^\n]*\n/, '').trim();
  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  const description = typeof raw['description'] === 'string' ? raw['description'].trim() : '';
  if (!SKILL_NAME.test(name)) throw new SkillParseError('`name` is lowercase letters, digits and dashes, 2–64 long.');
  if (!description || description.length > 500) throw new SkillParseError('`description` is one line, up to 500 characters.');
  if (!body) throw new SkillParseError('A skill has a body: what to do, step by step.');
  const metadata = raw['metadata'] && typeof raw['metadata'] === 'object' && !Array.isArray(raw['metadata']) ? raw['metadata'] : {};
  const nsRaw = metadata['milyonusagentskill'] ?? metadata['milyonus'];
  const ns = nsRaw && typeof nsRaw === 'object' && !Array.isArray(nsRaw) ? nsRaw : {};
  const provenance = ns['provenance'];
  return {
    meta: {
      name,
      description,
      version: raw['version'] === undefined || raw['version'] === null ? '0.1.0' : String(raw['version']),
      triggers: strings(ns['triggers'] ?? raw['triggers']),
      requiresTools: strings(ns['requires_tools'] ?? ns['requires_toolsets']),
      tags: strings(ns['tags']),
      category: typeof ns['category'] === 'string' ? ns['category'] : 'general',
      provenance: provenance === 'bundled' || provenance === 'official' || provenance === 'hub' ? 'bundled' : provenance === 'user' ? 'user' : 'learned',
    },
    body,
  };
}

export function renderSkill(meta: SkillMeta, body: string): string {
  const front = renderYaml({
    name: meta.name,
    description: meta.description,
    version: meta.version,
    metadata: {
      milyonusagentskill: {
        triggers: meta.triggers,
        requires_tools: meta.requiresTools,
        tags: meta.tags,
        category: meta.category,
        provenance: meta.provenance,
      },
    },
  });
  return `---\n${front}\n---\n\n${body.trim()}\n`;
}

/** A level-2 file's path: relative, inside the skill, no climbing out. */
export function safeSkillPath(path: string): string | null {
  const clean = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean || clean.startsWith('/') || clean.split('/').some((part) => part === '..' || part === '' || part.startsWith('.'))) return null;
  if (!/^[\w./-]{1,120}$/.test(clean) || clean.toUpperCase() === 'SKILL.MD') return null;
  return clean;
}
