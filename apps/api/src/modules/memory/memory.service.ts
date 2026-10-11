import { Inject, Injectable } from '@nestjs/common';
import {
  ErrorCode,
  type MemoryCreateInput,
  type MemoryDetailView,
  type MemoryItemView,
  type MemoryLedgerStatus,
  type MemoryListQuery,
  type MemoryListView,
  type MemoryRevocationPreview,
  MEMORY_LIMITS,
  type MemoryStateName,
} from '@milyonuse/contracts';
import {
  type Embedder,
  MEMORY_POLICY,
  ModelVerifier,
  type RunSource,
  RuleVerifier,
  type TrustTier,
  type Verifier,
  activateMessage,
  classifySensitivity,
  decide,
  deriveProvenance,
  evidenceHash,
  isRephrase,
  jaccard,
  overFetch,
  rankRecall,
  reaffirmCeiling,
  renderMemory,
  repromotionCeiling,
  stageMessage,
  tokens,
} from '@milyonuse/memory';
import { verifyOperator } from '@milyonuse/security';
import type pg from 'pg';
import { AppError } from '../../common/app-error.js';
import { AppLogger } from '../../common/logging/logger.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { rethrowDatabaseError } from '../tenancy/database-error.js';
import { TenantScope } from '../tenancy/tenant-scope.service.js';
import { UsageMeter } from '../usage/usage.meter.js';
import { AGENT_MODEL, type AgentModel } from '../agent/agent-model.port.js';
import { modelOptions, offeredModels } from '../agent/models.js';
import { MEMORY_EMBEDDER } from './embedder.js';
import { MemoryStore, type MemoryOwner, type MemoryRow, lensOf, memoryView, trustOf } from './memory.store.js';

/** What proposing a memory did, said to whoever proposed it. */
export interface ProposalOutcome {
  id: string;
  state: MemoryStateName;
  tier: TrustTier;
  reason: string;
  /** An existing claim this sighting confirmed, instead of a new memory. */
  confirmed?: boolean;
}

export interface ProposeInput {
  content: string;
  /** The agent (a tool call), or the person's own words (reflection, the page). */
  origin: 'agent' | 'person';
  conversationId?: string | null | undefined;
  runId?: string | null | undefined;
  /** The model asked for less trust than the turn would give. */
  lowerTier?: TrustTier | undefined;
  /** Memories the turn read that this one builds on. */
  parents?: readonly string[] | undefined;
}

/**
 * Verified memory (Phase 2; ported from Agent 5.5 `memory/pipeline.py`,
 * `semantic.py` and `usermodel.py`, with its gaps closed — F2 §3).
 *
 * The only path into memory: a candidate is written pending with provenance
 * the server derived from what the turn did; it is checked — a rephrase of a
 * rejected idea, the rules, then the model — and the tier rules decide. The
 * database enforces every rule again and ledgers every step; this service
 * only arranges the work.
 */
@Injectable()
export class MemoryService {
  constructor(
    private readonly store: MemoryStore,
    private readonly scope: TenantScope,
    private readonly usage: UsageMeter,
    @Inject(MEMORY_EMBEDDER) private readonly embedder: Embedder,
    @Inject(AGENT_MODEL) private readonly model: AgentModel,
    @Inject(ENV) private readonly env: Env,
    private readonly logger: AppLogger,
  ) {}

  /**
   * Who checks a candidate: the rules, then — where the router is configured
   * and the deployment asks for it — the Fast model, its spend counted to the
   * person whose memory it is.
   */
  private verifierFor(principal: MemoryOwner): Verifier {
    return this.env.MEMORY_VERIFIER === 'model' && this.model.name === 'openrouter'
      ? new ModelVerifier(this.judge(principal))
      : new RuleVerifier();
  }

  // ─────────────────────────────────────────────────────────────── propose

  async propose(principal: MemoryOwner, input: ProposeInput): Promise<ProposalOutcome> {
    const content = input.content.replace(/\s+/g, ' ').trim().slice(0, MEMORY_LIMITS.contentChars);
    if (!content) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Write what to remember.');
    const runSources = input.runId && input.origin === 'agent' ? await this.runSources(principal, input.runId) : [];
    const derived = deriveProvenance({
      origin: input.origin,
      runSources,
      lowerTier: input.lowerTier,
    });
    const provenance = {
      sourceKind: derived.sourceKind,
      sourceUri: derived.sourceUri,
      conversationId: input.conversationId ?? null,
      runId: input.runId ?? null,
      actor: input.origin === 'person' ? `member:${principal.memberId}` : 'agent',
    };
    const evidence = evidenceHash(content, provenance);

    const setup = await this.store.run(principal, async (client) => {
      // Already known, word for word: nothing new to keep.
      const known = (await this.store.active(client, { limit: 500, lens: lensOf(principal) })).find(
        (m) => m.content.toLocaleLowerCase('tr') === content.toLocaleLowerCase('tr'),
      );
      if (known) return { known };
      // An outside claim seen again, from another source: that is a confirmation, not a new memory.
      if (derived.tier === 'T3') {
        const claim = (await this.store.pendingClaims(client, lensOf(principal))).find(
          (m) => jaccard(m.content, content) >= MEMORY_POLICY.rephraseJaccard,
        );
        if (claim) {
          if (claim.source_uri === derived.sourceUri) return { repeat: claim };
          // A savepoint, so a refused confirmation leaves the rest of the transaction usable.
          await client.query('SAVEPOINT confirmation');
          try {
            await this.store.confirm(client, principal, claim.id, {
              evidenceHash: evidence,
              sourceKind: derived.sourceKind,
              sourceUri: derived.sourceUri,
              runId: input.runId ?? null,
            });
          } catch (error) {
            // The same source, or the same evidence, again: not independent — nothing gained.
            await client.query('ROLLBACK TO SAVEPOINT confirmation');
            const translated = (error as { hint?: string; code?: string }).hint ?? (error as { code?: string }).code;
            if (translated === 'memory_confirmation_not_independent' || translated === '23505') return { repeat: claim };
            throw error;
          }
          // The claim now leans on this source too: withdrawing it takes the claim with it.
          await this.store.derive(client, principal, claim.id, {
            sourceUris: derived.derivedFrom,
            parentIds: [],
          });
          return { confirmed: claim };
        }
      }
      return {};
    });
    if (setup.known) {
      return {
        id: setup.known.id,
        state: setup.known.state,
        tier: setup.known.tier,
        reason: 'already remembered',
      };
    }
    if (setup.repeat) {
      return {
        id: setup.repeat.id,
        state: setup.repeat.state,
        tier: setup.repeat.tier,
        reason: 'already waiting for confirmation from another source',
      };
    }
    if (setup.confirmed) {
      const outcome = await this.process(principal, setup.confirmed.id);
      return { ...outcome, confirmed: true };
    }

    const embedding = await this.embedOne(principal, content);
    const id = await this.store.run(principal, async (client) => {
      try {
        const created = await this.store.insert(client, principal, {
          content,
          tier: derived.tier,
          sourceKind: derived.sourceKind,
          sourceUri: derived.sourceUri,
          conversationId: provenance.conversationId,
          runId: provenance.runId,
          actor: provenance.actor,
          evidenceHash: evidence,
          sensitivity: classifySensitivity(content),
          ceiling: MEMORY_POLICY.ceiling[derived.tier],
          embedding,
          embeddingModel: embedding ? this.embedder.model : null,
          // What an agent with its own memory learns is its own; what the person says of themselves is theirs.
          agentId: input.origin === 'agent' ? (principal.agentId ?? null) : null,
        });
        await this.store.derive(client, principal, created, {
          sourceUris: derived.derivedFrom,
          parentIds: input.parents ?? [],
        });
        return created;
      } catch (error) {
        rethrowDatabaseError(error);
      }
    });
    return this.process(principal, id);
  }

  /**
   * Checks a pending memory and applies the tier rules: a rephrase of a
   * rejected idea, the verifier, then promote, wait, or reject — and a
   * refusal is remembered, so the same idea in other words is caught next time.
   */
  async process(principal: MemoryOwner, id: string): Promise<ProposalOutcome> {
    const { item, negatives, existing, embedding } = await this.store.run(principal, async (client) => ({
      item: await this.store.get(client, id),
      negatives: await this.store.negatives(client),
      existing: (await this.store.active(client, { limit: 50, lens: lensOf(principal) })).map((m) => m.content),
      embedding: await this.store.embeddingOf(client, id),
    }));
    if (item.state !== 'pending')
      return {
        id,
        state: item.state,
        tier: item.tier,
        reason: item.state_reason ?? item.state,
      };

    const rephrase = isRephrase(
      {
        content: item.content,
        embedding: embedding.embedding,
        embeddingModel: embedding.model,
      },
      negatives.map((n) => ({
        content: n.content,
        embedding: n.embedding,
        embeddingModel: n.embedding_model,
      })),
    );
    const verdict = rephrase.rephrase
      ? {
          approved: false,
          reason: 'rephrase',
          isInstruction: false,
          sourceCompetent: true,
          contradicts: false,
        }
      : await this.verifierFor(principal).verify({
          content: item.content,
          sourceKind: item.source_kind,
          tier: item.tier,
          existing,
        });
    const decision = decide({
      tier: item.tier,
      verdict,
      rephraseOf: rephrase.rephrase ? rephrase.matched : null,
      confirmations: item.confirmations,
    });

    return this.store.run(principal, async (client) => {
      try {
        switch (decision.action) {
          case 'reject':
            await this.store.transition(client, id, 'rejected', {
              reason: decision.reason,
              verdict: verdict.reason,
            });
            if (decision.remember) {
              await this.store.addNegative(client, principal, {
                itemId: id,
                content: item.content,
                reason: decision.reason,
                sourceUri: item.source_uri,
                embedding: embedding.embedding,
                embeddingModel: embedding.model,
              });
            }
            return {
              id,
              state: 'rejected' as const,
              tier: item.tier,
              reason: decision.reason,
            };
          case 'promote':
            await this.store.transition(client, id, 'active', {
              verdict: decision.reason,
              reason: 'verified',
            });
            return {
              id,
              state: 'active' as const,
              tier: item.tier,
              reason: decision.reason,
            };
          case 'await_confirmation':
            await this.store.setExpiry(client, id, decision.expiresInDays);
            return {
              id,
              state: 'pending' as const,
              tier: item.tier,
              reason: decision.reason,
            };
          case 'await_approval':
            return {
              id,
              state: 'pending' as const,
              tier: item.tier,
              reason: decision.reason,
            };
        }
      } catch (error) {
        rethrowDatabaseError(error);
      }
    });
  }

  /** The person adds a memory in their own words: T1, checked like any other. */
  async create(principal: MemoryOwner, input: MemoryCreateInput): Promise<MemoryItemView> {
    const outcome = await this.propose(principal, {
      content: input.content,
      origin: 'person',
    });
    if (outcome.state === 'rejected') throw new AppError(ErrorCode.CONFLICT, `Not kept: ${outcome.reason}.`);
    return this.store.run(principal, async (client) => memoryView(await this.store.get(client, outcome.id)));
  }

  // ──────────────────────────────────────────────────── the person decides

  /** The person approves a waiting memory — the only way an unknown or subagent claim is kept. */
  async approve(principal: MemoryOwner, id: string): Promise<MemoryItemView> {
    return this.store.run(principal, async (client) => {
      const item = await this.store.get(client, id);
      if (item.member_id === null) throw AppError.permissionDenied('An operator memory is not the person’s to approve.');
      if (item.state !== 'pending') throw new AppError(ErrorCode.CONFLICT, 'Only a memory waiting for approval can be approved.');
      try {
        await this.store.transition(client, id, 'active', {
          approvedBy: principal.memberId,
          reason: 'approved by the person',
        });
      } catch (error) {
        rethrowDatabaseError(error);
      }
      return memoryView(await this.store.get(client, id));
    });
  }

  /**
   * The person reaffirms a memory: its trust is restored — at most once a day,
   * less each time after the third, and never above its tier's ceiling. A
   * demoted memory returns on it, under a lower ceiling than before.
   */
  async reaffirm(principal: MemoryOwner, id: string): Promise<MemoryItemView> {
    return this.store.run(principal, async (client) => {
      const item = await this.store.get(client, id);
      if (item.member_id === null) throw AppError.permissionDenied('An operator memory is reaffirmed by the operator.');
      if (item.state !== 'active' && item.state !== 'demoted') {
        throw new AppError(ErrorCode.CONFLICT, 'Only a kept or demoted memory can be reaffirmed.');
      }
      const last = item.last_reaffirmed_at;
      if (item.reaffirm_count > 0 && last && Date.now() - last.getTime() < MEMORY_POLICY.reaffirmIntervalHours * 3_600_000) {
        throw new AppError(ErrorCode.RATE_LIMITED, 'This memory was reaffirmed in the last day. Try again tomorrow.');
      }
      const ceiling = Math.min(MEMORY_POLICY.ceiling[item.tier], reaffirmCeiling(item.reaffirm_count + 1, 'weak'));
      try {
        if (item.state === 'demoted') {
          const lower = Math.min(ceiling, repromotionCeiling(Number(item.trust_ceiling)));
          await this.store.transition(client, id, 'active', {
            reason: 'reaffirmed by the person',
            ceiling: lower,
            reaffirm: true,
          });
        } else {
          await this.store.reaffirm(client, id, ceiling);
        }
      } catch (error) {
        rethrowDatabaseError(error);
      }
      return memoryView(await this.store.get(client, id));
    });
  }

  /** The person forgets a memory: it, and everything built on it, is revoked. */
  async forget(principal: MemoryOwner, id: string, reason: string): Promise<{ revoked: string[] }> {
    return this.store.run(principal, async (client) => {
      const item = await this.store.get(client, id);
      if (item.member_id === null) throw AppError.permissionDenied('An operator memory is withdrawn by the operator.');
      return { revoked: await this.store.revoke(client, null, id, reason) };
    });
  }

  /** The agent asks for a memory to be forgotten; the person decides on the Memory page. */
  async requestForget(principal: MemoryOwner, id: string, reason: string): Promise<boolean> {
    return this.store.run(principal, async (client) => {
      const item = await this.store.get(client, id);
      if (item.member_id === null) return false;
      return this.store.requestForget(client, id, reason.slice(0, 500));
    });
  }

  /** The person keeps a memory the agent asked to forget. */
  async keep(principal: MemoryOwner, id: string): Promise<MemoryItemView> {
    return this.store.run(principal, async (client) => {
      await this.store.get(client, id);
      await this.store.keep(client, id);
      return memoryView(await this.store.get(client, id));
    });
  }

  async revocationPreview(principal: MemoryOwner, sourceUri: string): Promise<MemoryRevocationPreview> {
    return this.store.run(principal, async (client) => ({
      sourceUri,
      items: (await this.store.revocationSet(client, sourceUri, null))
        .filter((m) => m.member_id !== null)
        .map((m) => ({ id: m.id, content: m.content, state: m.state })),
    }));
  }

  /** A source withdrawn: every memory from it and built on it falls, in one statement. */
  async revokeSource(principal: MemoryOwner, sourceUri: string, reason: string): Promise<{ revoked: string[]; skills: string[] }> {
    return this.store.run(principal, async (client) => ({
      revoked: await this.store.revoke(client, sourceUri, null, reason),
      // What an agent learned to do from the source goes with what it learned to know.
      skills: await this.store.revokeSkillsFrom(client, sourceUri, reason),
    }));
  }

  // ─────────────────────────────────────────────────────────────── reading

  async list(principal: MemoryOwner, query: MemoryListQuery): Promise<MemoryListView> {
    return this.store.run(principal, async (client) => {
      const now = new Date();
      const rows = await this.store.list(
        client,
        {
          state: query.state,
          tier: query.tier,
          q: query.q,
          forgetRequested: query.forget === 'requested',
        },
        MEMORY_LIMITS.page,
      );
      return {
        items: rows.map((r) => memoryView(r, now)),
        counts: await this.store.counts(client),
      };
    });
  }

  async detail(principal: MemoryOwner, id: string): Promise<MemoryDetailView> {
    return this.store.run(principal, async (client) => {
      const item = await this.store.get(client, id);
      // One client runs one query at a time.
      const ledger = await this.store.ledger(client, id);
      const confirmations = await this.store.confirmations(client, id);
      const derivations = await this.store.derivations(client, id);
      return {
        item: memoryView(item),
        ledger,
        confirmations,
        derivedFrom: {
          sourceUris: derivations.sourceUris,
          memories: derivations.parents,
        },
        derivatives: derivations.children,
      };
    });
  }

  async ledgerStatus(principal: MemoryOwner): Promise<MemoryLedgerStatus> {
    return this.store.run(principal, async (client) => {
      const result = await this.store.verifyLedger(client);
      return {
        intact: result.brokenSeq === null,
        checked: result.checked,
        brokenSeq: result.brokenSeq,
      };
    });
  }

  /**
   * Recall: memories close to the query, scored by similarity × current trust,
   * so a close but barely trusted match never outranks a trusted one. Words
   * stand in where vectors cannot help.
   */
  async recall(
    principal: MemoryOwner,
    query: string,
    k: number,
    filter: { tiers?: readonly TrustTier[] } = {},
  ): Promise<{ row: MemoryRow; score: number; trust: number }[]> {
    const embedding = await this.embedOne(principal, query);
    return this.store.run(principal, async (client) => {
      const now = new Date();
      const allowed = (r: MemoryRow) => r.member_id !== null && (!filter.tiers || filter.tiers.includes(r.tier));
      let candidates: { item: MemoryRow; similarity: number; trust: number }[] = embedding
        ? (await this.store.nearest(client, embedding, this.embedder.model, overFetch(k), lensOf(principal))).filter(allowed).map((r) => ({
            item: r,
            similarity: Number(r.similarity),
            trust: trustOf(r, now),
          }))
        : [];
      if (candidates.length === 0) {
        const words = [...tokens(query)].slice(0, 12);
        candidates = (await this.store.byWords(client, words, overFetch(k), lensOf(principal))).filter(allowed).map((r) => ({
          item: r,
          similarity: jaccard(query, r.content) || 0.1,
          trust: trustOf(r, now),
        }));
      }
      return rankRecall(candidates, k).map((r) => ({
        row: r.item,
        score: r.score,
        trust: trustOf(r.item, now),
      }));
    });
  }

  /**
   * What the agent remembers, for the prompt of a turn about `query`: the
   * operator's policy whole, what is relevant to the turn, and the most
   * recent things the person said about themselves.
   */
  async renderFor(principal: MemoryOwner, query: string): Promise<string> {
    try {
      const recalled = await this.recall(principal, query, 12);
      const { operator, profile } = await this.store.run(principal, async (client) => ({
        operator: (await this.store.active(client, { tiers: ['T0'], limit: 50, lens: null })).filter((m) => m.member_id === null),
        profile: await this.store.active(client, { tiers: ['T1'], limit: 8, lens: null }),
      }));
      const now = new Date();
      const seen = new Set<string>();
      const memories = [...recalled.map((r) => r.row), ...profile]
        .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
        .map((m) => ({
          id: m.id,
          content: m.content,
          tier: m.tier,
          trust: trustOf(m, now),
          createdAt: m.created_at,
        }));
      return renderMemory({
        operator: operator.map((m) => ({
          id: m.id,
          content: m.content,
          tier: m.tier,
          trust: 1,
          createdAt: m.created_at,
        })),
        memories,
      });
    } catch (error) {
      // A turn goes on without memory rather than not at all.
      this.logger.warn('memory not rendered', {
        err: error instanceof Error ? error.message : String(error),
      });
      return '';
    }
  }

  // ──────────────────────────────────────────────────────────────── a turn

  /** What a turn read from outside, so what it proposes is derived from it (D-12). */
  async recordTaint(
    principal: MemoryOwner,
    run: { conversationId: string; runId: string },
    sources: readonly RunSource[],
  ): Promise<void> {
    if (sources.length === 0) return;
    await this.store.run(principal, (client) => this.store.recordTaint(client, principal, run, sources));
  }

  async runSources(principal: MemoryOwner, runId: string): Promise<RunSource[]> {
    return this.store.run(principal, (client) => this.store.runSources(client, runId));
  }

  // ───────────────────────────────────────────────────── operator (T0)

  /**
   * Stages an operator's claim for one organization. The signature over the
   * claim is the only authentication — no session reaches this — and the
   * claim is staged, not active: activation is a second signature, later.
   */
  async stageOperator(input: { organizationId: string; content: string; signature: string }): Promise<{ id: string }> {
    const keys = this.operatorKeys();
    const fingerprint = verifyOperator(keys, stageMessage(input.organizationId, input.content), input.signature);
    if (!fingerprint) throw AppError.permissionDenied('The operator signature does not verify.');
    const provenance = {
      sourceKind: 'operator' as const,
      sourceUri: null,
      conversationId: null,
      runId: null,
      actor: 'operator',
    };
    return this.scope.run(input.organizationId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO memory_items (organization_id, content, tier, state, source_kind, actor, evidence_hash, sensitivity,
                                   signature, key_fingerprint)
         VALUES ($1, $2, 'T0', 't0_staged', 'operator', 'operator', $3, $4, $5, $6) RETURNING id`,
        [
          input.organizationId,
          input.content,
          evidenceHash(input.content, provenance),
          classifySensitivity(input.content),
          input.signature,
          fingerprint,
        ],
      );
      return { id: rows[0]!.id };
    });
  }

  async activateOperator(input: {
    organizationId: string;
    itemId: string;
    signature: string;
  }): Promise<{ id: string; state: 'active' }> {
    return this.scope.run(input.organizationId, async (client: pg.PoolClient) => {
      const { rows } = await client.query<{
        evidence_hash: string;
        state: string;
      }>(`SELECT evidence_hash, state::text AS state FROM memory_items WHERE id = $1 AND tier = 'T0'`, [input.itemId]);
      const staged = rows[0];
      if (!staged || staged.state !== 't0_staged') throw AppError.notFound('Staged operator memory');
      if (!verifyOperator(this.operatorKeys(), activateMessage(input.itemId, staged.evidence_hash), input.signature)) {
        throw AppError.permissionDenied('The activation signature does not verify.');
      }
      try {
        await client.query(
          `UPDATE memory_items SET state = 'active', activation_signature = $2, state_reason = 'operator-signed' WHERE id = $1`,
          [input.itemId, input.signature],
        );
      } catch (error) {
        rethrowDatabaseError(error);
      }
      return { id: input.itemId, state: 'active' as const };
    });
  }

  private operatorKeys(): string[] {
    return this.env.MEMORY_OPERATOR_KEYS.map((key) => Buffer.from(key, 'base64').toString('utf8'));
  }

  // ─────────────────────────────────────────────────────────────── helpers

  /** The embedder vectors are made with now — stored beside each, so another embedder's are never compared. */
  get embeddingModel(): string {
    return this.embedder.model;
  }

  /** A vector for the text, or null — memory is kept, and recalled by words, without one. */
  async embedOne(principal: MemoryOwner, text: string): Promise<number[] | null> {
    try {
      const [vector] = await this.embedder.embed([text]);
      if (this.embedder.model.startsWith('fnv1a-')) return vector ?? null;
      await this.usage.memoryEmbedding({
        organizationId: principal.organizationId,
        memberId: principal.memberId,
      });
      return vector ?? null;
    } catch (error) {
      this.logger.warn('memory not embedded', {
        err: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** The Fast-tier model, as the verifier's judge: strict, short, no tools — metered like every call. */
  private judge(principal: MemoryOwner) {
    const offered = offeredModels(this.env);
    const fast = modelOptions(offered, this.env.AGENT_MODEL_LABELS).find((m) => m.tier === 'fast')?.id ?? this.env.AGENT_MODEL;
    const who = {
      organizationId: principal.organizationId,
      memberId: principal.memberId,
    };
    return async (system: string, prompt: string): Promise<string> => {
      try {
        const result = await this.model.complete({
          model: fast,
          system,
          messages: [{ role: 'user', content: prompt }],
          tools: [],
          maxTokens: 200,
          user: principal.memberId,
          signal: AbortSignal.timeout(20_000),
        });
        await this.usage.agentCall(who, result.usage);
        return result.text;
      } catch (error) {
        await this.usage.agentCall(who, (error as { usage?: { input: number; output: number } | null }).usage ?? null);
        throw error;
      }
    };
  }
}
