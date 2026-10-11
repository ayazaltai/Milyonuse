import { Injectable } from '@nestjs/common';
import {
  ErrorCode,
  type Principal,
  type SkillCatalogueEntry,
  type SkillDetailView,
  type SkillFindingView,
  type SkillSummaryView,
  type SkillWrite,
} from '@milyonuse/contracts';
import {
  BUNDLED_SKILLS,
  type SkillMeta,
  SkillParseError,
  bundledSkill,
  parseSkill,
  renderSkill,
  safeSkillPath,
  scanSkill,
  worstVerdict,
} from '@milyonuse/skills';
import type pg from 'pg';
import { AppError } from '../../common/app-error.js';
import { AuditService } from '../tenancy/audit.service.js';
import { rethrowDatabaseError } from '../tenancy/database-error.js';
import { MemoryService } from '../memory/memory.service.js';
import { enqueue } from '../queue/job.js';
import { JobWorker } from '../queue/job.worker.js';
import { type Owner, type SkillRow, StudioStore, skillDetail, skillSummary } from './studio.store.js';

/** The queue's kind for a replay (0005 jobs). */
export const SKILL_REPLAY_JOB = 'skill_replay';

/** What a learned skill is proposed with: the procedure, in the model's words, made into a SKILL.md here. */
export interface LearnedSkill {
  name: string;
  description: string;
  triggers: string[];
  requiresTools: string[];
  steps: string;
}

/** Where a learned skill came from: the turn — its conversation, the person's message, what it read. */
export interface LearnedFrom {
  conversationId: string;
  runId: string;
  /** The proposing agent may approve a clean skill that passes its replay by itself. */
  trusted: boolean;
}

export interface ProposedSkill {
  skillId: string;
  versionId: string;
  name: string;
  version: number;
  state: 'staging' | 'rejected';
  verdict: 'clean' | 'caution' | 'danger';
  findings: SkillFindingView[];
}

/**
 * A person's skills (F4 §2): the reviewed bundled ones, the ones they write,
 * and the ones their agents learn. Every version except a bundled one enters
 * staging, is scanned — a danger verdict is final, a caution needs the
 * person's insistence — and is replayed before anyone may approve it.
 * Approval makes it the skill's active version; the one before it is
 * superseded. A version learned from a source falls with the source
 * (MemoryService.revokeSource, acceptance 3).
 */
@Injectable()
export class SkillsService {
  constructor(
    private readonly store: StudioStore,
    private readonly memory: MemoryService,
    private readonly audit: AuditService,
    private readonly worker: JobWorker,
  ) {}

  // ─────────────────────────────────────────────────────────────── reading

  async list(principal: Principal): Promise<SkillSummaryView[]> {
    return this.store.run(principal, async (client) => {
      const skills = await this.store.skills(client);
      const versions = await this.store.skillVersions(client, skills.map((s) => s.id));
      const runs = await this.store.skillRuns(
        client,
        versions.filter((v) => v.state === 'staging').map((v) => v.id),
      );
      return skills.map((s) => skillSummary(s, versions, runs, titleOf(s)));
    });
  }

  async detail(principal: Principal, id: string): Promise<SkillDetailView> {
    return this.store.run(principal, (client) => this.detailIn(client, id));
  }

  private async detailIn(client: pg.PoolClient, id: string): Promise<SkillDetailView> {
    const skill = await this.store.skill(client, id);
    const versions = await this.store.skillVersions(client, [id]);
    const runs = await this.store.skillRuns(client, versions.map((v) => v.id));
    return skillDetail(skill, versions, runs, titleOf(skill));
  }

  async catalogue(principal: Principal): Promise<SkillCatalogueEntry[]> {
    const owned = new Set((await this.store.run(principal, (client) => this.store.skills(client))).map((s) => s.name));
    return BUNDLED_SKILLS.map((b) => {
      const meta = parseSkill(b.md).meta;
      return {
        name: b.name,
        title: b.title,
        summary: b.summary,
        category: meta.category,
        requiresTools: meta.requiresTools,
        added: owned.has(b.name),
      };
    });
  }

  // ────────────────────────────────────────────────────────────── adding

  /** A reviewed bundled skill into the person's library, active at once. */
  async addBundled(principal: Principal, name: string): Promise<SkillDetailView> {
    const id = await this.store.run(principal, async (client) => {
      const found = await this.ensureBundled(client, principal, name);
      await this.note(client, principal, 'skill.added', found);
      return found;
    });
    return this.detail(principal, id);
  }

  /** In the caller's transaction: the bundled skill's id, added when the person does not have it yet. */
  async ensureBundled(client: pg.PoolClient, owner: Owner, name: string): Promise<string> {
    const entry = bundledSkill(name);
    if (!entry) throw AppError.notFound('Bundled skill');
    const existing = await this.store.skillByName(client, name);
    if (existing) {
      if (existing.source !== 'bundled') {
        throw new AppError(ErrorCode.CONFLICT, `You already have a skill named ${name}.`);
      }
      return existing.id;
    }
    const findings = scanSkill(entry.md);
    // The catalogue is tested clean; a bundled skill that is not never enters active.
    if (worstVerdict(findings) !== 'clean') throw new Error(`Bundled skill ${name} does not scan clean`);
    const skillId = await this.store.createSkill(client, owner, name, 'bundled');
    const versionId = await this.store.addSkillVersion(client, owner, skillId, {
      description: entry.skill.meta.description,
      content: entry.md,
      files: [],
      verdict: 'clean',
      findings: [],
      state: 'active',
    });
    await this.store.setCurrentSkillVersion(client, skillId, versionId);
    return skillId;
  }

  /**
   * A skill the person wrote: a new skill, or a new version of one of theirs
   * by the same name. Scanned — danger is refused, caution needs `force` —
   * then staged and replayed; it is used only once they approve it.
   */
  async write(principal: Principal, input: SkillWrite): Promise<SkillDetailView> {
    let meta: SkillMeta;
    try {
      meta = parseSkill(input.content).meta;
    } catch (error) {
      if (error instanceof SkillParseError) throw new AppError(ErrorCode.VALIDATION_FAILED, error.message);
      throw error;
    }
    const files = input.files.map((f) => {
      const path = safeSkillPath(f.path);
      if (!path) throw new AppError(ErrorCode.VALIDATION_FAILED, `A file beside a skill has a plain relative path: ${f.path.slice(0, 60)}`);
      return { path, content: f.content };
    });
    const findings = [input.content, ...files.map((f) => f.content)].flatMap((text) => scanSkill(text));
    const verdict = worstVerdict(findings);
    if (verdict === 'danger') {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'This skill contains something dangerous and cannot be kept.', {
        details: detailsOf(findings),
      });
    }
    if (verdict === 'caution' && !input.force) {
      throw new AppError(ErrorCode.CONFLICT, 'The scanner has a caution about this skill. Read it, and keep it anyway only if you are sure.', {
        details: detailsOf(findings),
      });
    }
    const { skillId } = await this.store.run(principal, async (client) => {
      const existing = await this.store.skillByName(client, meta.name, true);
      const skillId = existing?.id ?? (await this.store.createSkill(client, principal, meta.name, 'user'));
      const versionId = await this.stage(client, principal, skillId, {
        description: meta.description,
        content: input.content,
        files,
        verdict,
        findings,
        task: null,
      });
      await this.note(client, principal, 'skill.written', skillId, { versionId, verdict });
      return { skillId };
    });
    this.worker.kick();
    return this.detail(principal, skillId);
  }

  /**
   * What an agent learned (skill_propose): made into a SKILL.md here, scanned,
   * and staged with where it came from — the turn's conversation, the
   * person's message as its task, and every outside source the turn read, so
   * it falls with any of them. A danger verdict is kept as a rejected version,
   * evidence for the person, and never replayed.
   */
  async learn(principal: Principal, input: LearnedSkill, from: LearnedFrom): Promise<ProposedSkill> {
    const content = renderSkill(
      {
        name: input.name,
        description: input.description,
        version: '1.0.0',
        triggers: input.triggers,
        requiresTools: input.requiresTools,
        tags: [],
        category: 'learned',
        provenance: 'learned',
      },
      input.steps,
    );
    const findings = scanSkill(content);
    const verdict = worstVerdict(findings);
    const derivedFrom = (await this.memory.runSources(principal, from.runId)).map((s) => s.uri);
    const result = await this.store.run(principal, async (client) => {
      const existing = await this.store.skillByName(client, input.name, true);
      const skillId = existing?.id ?? (await this.store.createSkill(client, principal, input.name, 'learned'));
      const task = (await this.store.runTask(client, from.runId))?.slice(0, 4000) ?? null;
      const versionId = await this.stage(
        client,
        principal,
        skillId,
        {
          description: input.description,
          content,
          files: [],
          verdict,
          findings,
          task,
          sourceConversationId: from.conversationId,
          sourceRunId: from.runId,
          derivedFrom,
        },
        { trusted: from.trusted },
      );
      if (verdict === 'danger') {
        await this.store.moveSkillVersion(client, versionId, 'rejected', { reason: 'The scanner rated it danger.' });
      }
      await this.note(client, principal, 'skill.learned', skillId, { versionId, verdict, sources: derivedFrom.length });
      return { skillId, version: await this.store.skillVersion(client, versionId) };
    });
    this.worker.kick();
    return {
      skillId: result.skillId,
      versionId: result.version.id,
      name: input.name,
      version: result.version.version,
      state: result.version.state === 'rejected' ? 'rejected' : 'staging',
      verdict,
      findings,
    };
  }

  /** A staged version, with its replay queued unless the scanner already settled it. */
  private async stage(
    client: pg.PoolClient,
    principal: Owner,
    skillId: string,
    v: {
      description: string;
      content: string;
      files: { path: string; content: string }[];
      verdict: 'clean' | 'caution' | 'danger';
      findings: SkillFindingView[];
      task: string | null;
      sourceConversationId?: string;
      sourceRunId?: string;
      derivedFrom?: string[];
    },
    options: { trusted?: boolean } = {},
  ): Promise<string> {
    // One version waits at a time: a newer one replaces what was still staged.
    for (const older of (await this.store.skillVersions(client, [skillId])).filter((x) => x.state === 'staging')) {
      await this.store.moveSkillVersion(client, older.id, 'rejected', { reason: 'Replaced by a newer version.' });
    }
    const versionId = await this.store.addSkillVersion(client, principal, skillId, { ...v, state: 'staging' });
    if (v.verdict !== 'danger') await this.queueReplay(client, principal, versionId, options.trusted ?? false);
    return versionId;
  }

  private async queueReplay(client: pg.PoolClient, owner: Owner, versionId: string, trusted: boolean, attempt = 0): Promise<void> {
    await enqueue(client, {
      organizationId: owner.organizationId,
      kind: SKILL_REPLAY_JOB,
      payload: { versionId, memberId: owner.memberId, trusted },
      dedupeKey: `skill_replay:${versionId}:${attempt}`,
      maxAttempts: 3,
    });
  }

  // ──────────────────────────────────────────────────────────── deciding

  async setEnabled(principal: Principal, id: string, enabled: boolean): Promise<SkillDetailView> {
    return this.store.run(principal, async (client) => {
      await this.store.skill(client, id, true);
      await this.store.setSkillEnabled(client, id, enabled);
      await this.note(client, principal, enabled ? 'skill.enabled' : 'skill.disabled', id);
      return this.detailIn(client, id);
    });
  }

  /**
   * The person approves a staged version: it becomes the skill's active one.
   * The database refuses it without a passing replay, or ever for danger.
   */
  async approve(principal: Principal, versionId: string): Promise<SkillDetailView> {
    return this.store.run(principal, async (client) => {
      const version = await this.store.skillVersion(client, versionId, true);
      await this.activate(client, version.skill_id, versionId, principal.memberId);
      await this.note(client, principal, 'skill.approved', version.skill_id, { versionId });
      return this.detailIn(client, version.skill_id);
    });
  }

  /** In the caller's transaction: active now, the previous active version superseded, and current. */
  async activate(client: pg.PoolClient, skillId: string, versionId: string, approvedBy: string | null): Promise<void> {
    const skill = await this.store.skill(client, skillId, true);
    try {
      await this.store.moveSkillVersion(client, versionId, 'active', { approve: true, approvedBy });
    } catch (error) {
      rethrowDatabaseError(error);
    }
    if (skill.current_version_id && skill.current_version_id !== versionId) {
      const previous = await this.store.skillVersion(client, skill.current_version_id);
      if (previous.state === 'active') {
        await this.store.moveSkillVersion(client, previous.id, 'superseded', { reason: 'A newer version was approved.' });
      }
    }
    await this.store.setCurrentSkillVersion(client, skillId, versionId);
  }

  async reject(principal: Principal, versionId: string, reason: string | undefined): Promise<SkillDetailView> {
    return this.store.run(principal, async (client) => {
      const version = await this.store.skillVersion(client, versionId, true);
      try {
        await this.store.moveSkillVersion(client, versionId, 'rejected', { reason: reason || 'Rejected by you.' });
      } catch (error) {
        rethrowDatabaseError(error);
      }
      await this.note(client, principal, 'skill.rejected', version.skill_id, { versionId });
      return this.detailIn(client, version.skill_id);
    });
  }

  /** Runs a staged version's replay again — after a failure the person thinks was not the skill's. */
  async replayAgain(principal: Principal, versionId: string): Promise<SkillDetailView> {
    const detail = await this.store.run(principal, async (client) => {
      const version = await this.store.skillVersion(client, versionId, true);
      if (version.state !== 'staging') throw new AppError(ErrorCode.CONFLICT, 'Only a version waiting for a decision is replayed.');
      if (version.scan_verdict === 'danger') throw new AppError(ErrorCode.CONFLICT, 'A skill rated danger is never replayed.');
      const runs = await this.store.skillRuns(client, [versionId]);
      if (runs.length >= 5) throw new AppError(ErrorCode.CONFLICT, 'This version has been replayed enough times. Write a new version instead.');
      await this.queueReplay(client, principal, versionId, false, runs.length);
      return this.detailIn(client, version.skill_id);
    });
    this.worker.kick();
    return detail;
  }

  /** Every skill a version list names must be the person's own. */
  async checkOwn(client: pg.PoolClient, ids: readonly string[]): Promise<void> {
    const own = await this.store.ownSkillIds(client, ids);
    const foreign = ids.filter((id) => !own.has(id));
    if (foreign.length > 0) throw new AppError(ErrorCode.VALIDATION_FAILED, `Not one of your skills: ${foreign.slice(0, 3).join(', ')}.`);
  }

  /** The audit entry for a change to a skill, in the change's transaction. */
  private note(client: pg.PoolClient, principal: Owner, action: string, skillId: string, after?: Record<string, unknown>): Promise<void> {
    return this.audit.record(client, {
      organizationId: principal.organizationId,
      actorMemberId: principal.memberId,
      action,
      resourceType: 'skill',
      resourceId: skillId,
      after,
    });
  }
}

/** The scanner's findings, as the error contract's details. */
function detailsOf(findings: readonly SkillFindingView[]): { path: string; message: string }[] {
  return findings.slice(0, 20).map((f) => ({ path: f.signal, message: `${f.verdict}: ${f.detail}` }));
}

function titleOf(skill: SkillRow): { en: string; tr: string } | null {
  return skill.source === 'bundled' ? (bundledSkill(skill.name)?.title ?? null) : null;
}
