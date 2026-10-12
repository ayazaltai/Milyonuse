import { Injectable } from '@nestjs/common';
import type {
  MemoryItemView,
  MemoryLedgerEntryView,
  MemorySourceKind,
  MemoryStateName,
  MemoryTier,
  Principal,
} from '@milyonuse/contracts';
import { type Sensitivity, currentTrust } from '@milyonuse/memory';
import type pg from 'pg';
import { AppError } from '../../common/app-error.js';
import { TenantScope } from '../tenancy/tenant-scope.service.js';

/**
 * Verified memory's records (0007), read and written in the person's own
 * scope — organization and member — so another person's memory is "not
 * found", never "not yours". The rules are the database's: this file only
 * asks, and every write it makes is ledgered by triggers it cannot bypass.
 */

/**
 * Whose memory: all the memory code needs of a principal — so the nightly
 * pass, with no session, uses it too. `agentId` and `teamId` are the lens of
 * a turn: one of the person's agents that keeps its own memory (0011), or a
 * team at work (0012). The turn reads the person's memory and that scope's,
 * and keeps what it learns in that scope — a team's before an agent's.
 */
export type MemoryOwner = Pick<Principal, 'organizationId' | 'memberId'> & {
  agentId?: string | null | undefined;
  teamId?: string | null | undefined;
};

/** Which memories a read sees: the person's, one scope's besides (`agent:<id>`, `team:<id>`), or — for the nightly pass — every scope. */
export type MemoryLens = string | null | '*';

/** The scope a turn reads and writes besides the person's own. */
export function scopeOf(owner: MemoryOwner): { kind: 'agent' | 'team'; ref: string } | null {
  if (owner.teamId) return { kind: 'team', ref: owner.teamId };
  if (owner.agentId) return { kind: 'agent', ref: owner.agentId };
  return null;
}

export function lensOf(owner: MemoryOwner): MemoryLens {
  const scope = scopeOf(owner);
  return scope ? `${scope.kind}:${scope.ref}` : null;
}

/** The lens as SQL, on parameter `$n`. */
function inLens(n: number): string {
  return `($${n}::text = '*' OR m.scope = 'user' OR (m.scope::text || ':' || m.scope_ref::text) = $${n}::text)`;
}

export interface MemoryRow {
  id: string;
  member_id: string | null;
  scope: 'user' | 'agent' | 'team';
  scope_ref: string | null;
  content: string;
  tier: MemoryTier;
  state: MemoryStateName;
  source_kind: MemorySourceKind;
  source_uri: string | null;
  conversation_id: string | null;
  run_id: string | null;
  actor: string;
  evidence_hash: string;
  sensitivity: Sensitivity;
  trust_ceiling: string;
  last_reaffirmed_at: Date | null;
  reaffirm_count: number;
  state_reason: string | null;
  verdict: string | null;
  verified_at: Date | null;
  demoted_at: Date | null;
  expires_at: Date | null;
  approved_at: Date | null;
  forget_requested_at: Date | null;
  forget_reason: string | null;
  flagged_with: string | null;
  embedding_model: string | null;
  created_at: Date;
  confirmations: number;
}

export interface NewMemory {
  content: string;
  tier: MemoryTier;
  sourceKind: MemorySourceKind;
  sourceUri: string | null;
  conversationId: string | null;
  runId: string | null;
  actor: string;
  evidenceHash: string;
  sensitivity: Sensitivity;
  ceiling: number;
  embedding: number[] | null;
  embeddingModel: string | null;
  /** One agent's or team's own (0011, 0012); the person's when absent. */
  scope?: { kind: 'agent' | 'team'; ref: string } | null | undefined;
}

const ITEM = `m.id, m.member_id, m.scope::text AS scope, m.scope_ref, m.content, m.tier::text AS tier, m.state::text AS state, m.source_kind::text AS source_kind,
  m.source_uri, m.conversation_id, m.run_id, m.actor, m.evidence_hash, m.sensitivity, m.trust_ceiling::text AS trust_ceiling,
  m.last_reaffirmed_at, m.reaffirm_count, m.state_reason, m.verdict, m.verified_at, m.demoted_at, m.expires_at,
  m.approved_at, m.forget_requested_at, m.forget_reason, m.flagged_with, m.embedding_model, m.created_at,
  (SELECT count(*)::int FROM memory_confirmations c WHERE c.item_id = m.id) AS confirmations`;

/** pgvector's text form of a vector. */
export function vectorLiteral(values: readonly number[]): string {
  return `[${values.map((v) => (Number.isFinite(v) ? v.toFixed(7) : '0')).join(',')}]`;
}

@Injectable()
export class MemoryStore {
  constructor(private readonly scope: TenantScope) {}

  run<T>(principal: MemoryOwner, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.scope.run(
      {
        organizationId: principal.organizationId,
        memberId: principal.memberId,
      },
      fn,
    );
  }

  /** For the nightly pass, which knows the person before it has a session for them. */
  runFor<T>(organizationId: string, memberId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.scope.run({ organizationId, memberId }, fn);
  }

  // ─────────────────────────────────────────────────────────────── items

  async get(client: pg.PoolClient, id: string): Promise<MemoryRow> {
    const { rows } = await client.query<MemoryRow>(`SELECT ${ITEM} FROM memory_items m WHERE m.id = $1`, [id]);
    if (!rows[0]) throw AppError.notFound('Memory');
    return rows[0];
  }

  async list(
    client: pg.PoolClient,
    filter: {
      state?: MemoryStateName | undefined;
      tier?: MemoryTier | undefined;
      q?: string | undefined;
      forgetRequested?: boolean;
    },
    limit: number,
  ): Promise<MemoryRow[]> {
    const pattern = filter.q ? `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const { rows } = await client.query<MemoryRow>(
      `SELECT ${ITEM} FROM memory_items m
        WHERE ($1::memory_state IS NULL OR m.state = $1)
          AND ($2::memory_tier IS NULL OR m.tier = $2)
          AND ($3::text IS NULL OR m.content ILIKE $3 OR m.source_uri ILIKE $3)
          AND (NOT $4 OR m.forget_requested_at IS NOT NULL AND m.state IN ('pending', 'active', 'demoted'))
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $5`,
      [filter.state ?? null, filter.tier ?? null, pattern, filter.forgetRequested ?? false, limit],
    );
    return rows;
  }

  async counts(client: pg.PoolClient): Promise<Record<MemoryStateName, number>> {
    const { rows } = await client.query<{ state: MemoryStateName; n: number }>(
      `SELECT state::text AS state, count(*)::int AS n FROM memory_items GROUP BY state`,
    );
    const counts = {
      pending: 0,
      active: 0,
      demoted: 0,
      rejected: 0,
      revoked: 0,
      expired: 0,
      t0_staged: 0,
    };
    for (const r of rows) counts[r.state] = r.n;
    return counts;
  }

  async insert(client: pg.PoolClient, principal: MemoryOwner, memory: NewMemory): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO memory_items (organization_id, member_id, content, tier, state, source_kind, source_uri, conversation_id,
                                 run_id, actor, evidence_hash, sensitivity, trust_ceiling, embedding, embedding_model,
                                 scope, scope_ref)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12, $13::vector, $14,
               COALESCE($15::text, 'user')::memory_scope, $16)
       RETURNING id`,
      [
        principal.organizationId,
        principal.memberId,
        memory.content,
        memory.tier,
        memory.sourceKind,
        memory.sourceUri,
        memory.conversationId,
        memory.runId,
        memory.actor,
        memory.evidenceHash,
        memory.sensitivity,
        memory.ceiling,
        memory.embedding ? vectorLiteral(memory.embedding) : null,
        memory.embedding ? memory.embeddingModel : null,
        memory.scope?.kind ?? null,
        memory.scope?.ref ?? null,
      ],
    );
    return rows[0]!.id;
  }

  async derive(
    client: pg.PoolClient,
    principal: MemoryOwner,
    itemId: string,
    edges: { sourceUris: readonly string[]; parentIds: readonly string[] },
  ): Promise<void> {
    for (const uri of edges.sourceUris) {
      await client.query(
        `INSERT INTO memory_derivations (organization_id, item_id, source_uri) VALUES ($1, $2, $3)
         ON CONFLICT ON CONSTRAINT memory_derivations_once DO NOTHING`,
        [principal.organizationId, itemId, uri],
      );
    }
    for (const parent of edges.parentIds) {
      if (parent === itemId) continue;
      await client.query(
        `INSERT INTO memory_derivations (organization_id, item_id, parent_item_id)
         SELECT $1, $2, m.id FROM memory_items m WHERE m.id = $3
         ON CONFLICT ON CONSTRAINT memory_derivations_once DO NOTHING`,
        [principal.organizationId, itemId, parent],
      );
    }
  }

  /** A state change, with why — the database checks the move and ledgers it. */
  async transition(
    client: pg.PoolClient,
    id: string,
    state: MemoryStateName,
    change: {
      reason?: string | undefined;
      verdict?: string | undefined;
      approvedBy?: string | undefined;
      ceiling?: number | undefined;
      reaffirm?: boolean | undefined;
    } = {},
  ): Promise<void> {
    await client.query(
      `UPDATE memory_items
          SET state = $2,
              state_reason = COALESCE($3, state_reason),
              verdict = COALESCE($4, verdict),
              approved_by = COALESCE($5, approved_by),
              approved_at = CASE WHEN $5::text IS NULL THEN approved_at ELSE clock_timestamp() END,
              trust_ceiling = COALESCE($6, trust_ceiling),
              reaffirm_count = reaffirm_count + CASE WHEN $7 THEN 1 ELSE 0 END,
              last_reaffirmed_at = CASE WHEN $7 THEN clock_timestamp() ELSE last_reaffirmed_at END
        WHERE id = $1`,
      [
        id,
        state,
        change.reason ?? null,
        change.verdict ?? null,
        change.approvedBy ?? null,
        change.ceiling ?? null,
        change.reaffirm ?? false,
      ],
    );
  }

  async setExpiry(client: pg.PoolClient, id: string, days: number): Promise<void> {
    await client.query(
      `UPDATE memory_items SET expires_at = COALESCE(expires_at, now() + make_interval(days => $2)) WHERE id = $1`,
      [id, days],
    );
  }

  /** The person's weak reaffirmation of an active memory: trust restored, under the ceiling given. */
  async reaffirm(client: pg.PoolClient, id: string, ceiling: number): Promise<void> {
    await client.query(
      `UPDATE memory_items
          SET reaffirm_count = reaffirm_count + 1, last_reaffirmed_at = clock_timestamp(), trust_ceiling = $2
        WHERE id = $1`,
      [id, ceiling],
    );
  }

  async requestForget(client: pg.PoolClient, id: string, reason: string): Promise<boolean> {
    const { rowCount } = await client.query(
      `UPDATE memory_items SET forget_requested_at = clock_timestamp(), forget_reason = $2
        WHERE id = $1 AND forget_requested_at IS NULL AND state IN ('pending', 'active', 'demoted')`,
      [id, reason],
    );
    return (rowCount ?? 0) > 0;
  }

  async keep(client: pg.PoolClient, id: string): Promise<void> {
    await client.query(`UPDATE memory_items SET forget_requested_at = NULL, forget_reason = NULL WHERE id = $1`, [id]);
  }

  async flag(client: pg.PoolClient, id: string, other: string): Promise<void> {
    await client.query(`UPDATE memory_items SET flagged_with = $2 WHERE id = $1 AND flagged_with IS NULL`, [id, other]);
  }

  async setEmbedding(client: pg.PoolClient, id: string, embedding: number[], model: string): Promise<void> {
    await client.query(`UPDATE memory_items SET embedding = $2::vector, embedding_model = $3 WHERE id = $1`, [
      id,
      vectorLiteral(embedding),
      model,
    ]);
  }

  // ─────────────────────────────────────────────────────── confirmation

  /** A pending outside claim that says the same, from another source — what a new sighting confirms. */
  async pendingClaims(client: pg.PoolClient, lens: MemoryLens): Promise<MemoryRow[]> {
    const { rows } = await client.query<MemoryRow>(
      `SELECT ${ITEM} FROM memory_items m WHERE m.tier = 'T3' AND m.state IN ('pending', 'demoted') AND ${inLens(1)}
        ORDER BY m.created_at DESC LIMIT 500`,
      [lens],
    );
    return rows;
  }

  async confirm(
    client: pg.PoolClient,
    principal: MemoryOwner,
    itemId: string,
    evidence: {
      evidenceHash: string;
      sourceKind: MemorySourceKind;
      sourceUri: string | null;
      runId: string | null;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO memory_confirmations (organization_id, item_id, evidence_hash, source_kind, source_uri, run_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [principal.organizationId, itemId, evidence.evidenceHash, evidence.sourceKind, evidence.sourceUri, evidence.runId],
    );
  }

  // ────────────────────────────────────────────────────────── negative

  async negatives(client: pg.PoolClient): Promise<
    {
      content: string;
      embedding: number[] | null;
      embedding_model: string | null;
    }[]
  > {
    const { rows } = await client.query<{
      content: string;
      embedding: string | null;
      embedding_model: string | null;
    }>(`SELECT content, embedding::text AS embedding, embedding_model FROM memory_negative ORDER BY created_at DESC LIMIT 500`);
    return rows.map((r) => ({
      ...r,
      embedding: r.embedding ? (JSON.parse(r.embedding) as number[]) : null,
    }));
  }

  async addNegative(
    client: pg.PoolClient,
    principal: MemoryOwner,
    negative: {
      itemId: string;
      content: string;
      reason: string;
      sourceUri: string | null;
      embedding: number[] | null;
      embeddingModel: string | null;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO memory_negative (organization_id, member_id, item_id, content, reason, source_uri, embedding, embedding_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)`,
      [
        principal.organizationId,
        principal.memberId,
        negative.itemId,
        negative.content,
        negative.reason.slice(0, 500),
        negative.sourceUri,
        negative.embedding ? vectorLiteral(negative.embedding) : null,
        negative.embedding ? negative.embeddingModel : null,
      ],
    );
  }

  /** The embedding a memory was stored with, for its negative twin. */
  async embeddingOf(client: pg.PoolClient, id: string): Promise<{ embedding: number[] | null; model: string | null }> {
    const { rows } = await client.query<{
      embedding: string | null;
      embedding_model: string | null;
    }>(`SELECT embedding::text AS embedding, embedding_model FROM memory_items WHERE id = $1`, [id]);
    const row = rows[0];
    return {
      embedding: row?.embedding ? (JSON.parse(row.embedding) as number[]) : null,
      model: row?.embedding_model ?? null,
    };
  }

  // ──────────────────────────────────────────────────────────── recall

  async nearest(
    client: pg.PoolClient,
    query: number[],
    model: string,
    limit: number,
    lens: MemoryLens,
  ): Promise<(MemoryRow & { similarity: number })[]> {
    const { rows } = await client.query<MemoryRow & { similarity: number }>(
      `SELECT ${ITEM}, 1 - (m.embedding <=> $1::vector) AS similarity
         FROM memory_items m
        WHERE m.state = 'active' AND m.embedding_model = $2 AND ${inLens(4)}
        ORDER BY m.embedding <=> $1::vector
        LIMIT $3`,
      [vectorLiteral(query), model, limit, lens],
    );
    return rows;
  }

  /** Recall by words, where vectors cannot help: no embedding yet, or another embedder's. */
  async byWords(client: pg.PoolClient, words: readonly string[], limit: number, lens: MemoryLens): Promise<MemoryRow[]> {
    if (words.length === 0) return [];
    const patterns = words.map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const { rows } = await client.query<MemoryRow>(
      `SELECT ${ITEM} FROM memory_items m
        WHERE m.state = 'active' AND m.content ILIKE ANY ($1::text[]) AND ${inLens(3)}
        ORDER BY m.created_at DESC LIMIT $2`,
      [patterns, limit, lens],
    );
    return rows;
  }

  async active(
    client: pg.PoolClient,
    filter: { tiers?: readonly MemoryTier[]; limit: number; lens: MemoryLens },
  ): Promise<MemoryRow[]> {
    const { rows } = await client.query<MemoryRow>(
      `SELECT ${ITEM} FROM memory_items m
        WHERE m.state = 'active' AND ($1::text[] IS NULL OR m.tier::text = ANY ($1::text[])) AND ${inLens(3)}
        ORDER BY m.created_at DESC LIMIT $2`,
      [filter.tiers ?? null, filter.limit, filter.lens],
    );
    return rows;
  }

  // ──────────────────────────────────────────────────────── revocation

  async revocationSet(client: pg.PoolClient, sourceUri: string | null, itemId: string | null): Promise<MemoryRow[]> {
    const { rows } = await client.query<MemoryRow>(
      `SELECT ${ITEM} FROM memory_items m WHERE m.id IN (SELECT id FROM app.memory_revocation_set($1, $2))
        ORDER BY m.created_at`,
      [sourceUri, itemId],
    );
    return rows;
  }

  async revoke(client: pg.PoolClient, sourceUri: string | null, itemId: string | null, reason: string): Promise<string[]> {
    const { rows } = await client.query<{ id: string }>(
      `UPDATE memory_items SET state = 'revoked', state_reason = $3
        WHERE id IN (SELECT id FROM app.memory_revocation_set($1, $2)) RETURNING id`,
      [sourceUri, itemId, reason.slice(0, 500)],
    );
    return rows.map((r) => r.id);
  }

  /**
   * Skills learned from a source fall with it (F4, acceptance 3): every staged
   * or active skill version a turn derived from it is revoked in the same
   * transaction as the memory.
   */
  async revokeSkillsFrom(client: pg.PoolClient, sourceUri: string, reason: string): Promise<string[]> {
    const { rows } = await client.query<{ id: string }>(
      `UPDATE skill_versions SET state = 'revoked', state_reason = $2
        WHERE state IN ('staging', 'active') AND $1 = ANY (derived_from) RETURNING id`,
      [sourceUri, reason.slice(0, 500)],
    );
    return rows.map((r) => r.id);
  }

  // ─────────────────────────────────────────────────────────── taint

  async recordTaint(
    client: pg.PoolClient,
    principal: MemoryOwner,
    run: { conversationId: string; runId: string },
    sources: readonly {
      kind: 'third_party' | 'subagent' | 'unknown';
      uri: string;
    }[],
  ): Promise<void> {
    for (const s of sources) {
      await client.query(
        `INSERT INTO run_taint (organization_id, member_id, conversation_id, run_id, source_kind, source_uri)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT ON CONSTRAINT run_taint_once DO NOTHING`,
        [principal.organizationId, principal.memberId, run.conversationId, run.runId, s.kind, s.uri],
      );
    }
  }

  async runSources(
    client: pg.PoolClient,
    runId: string,
  ): Promise<{ kind: 'third_party' | 'subagent' | 'unknown'; uri: string }[]> {
    const { rows } = await client.query<{
      kind: 'third_party' | 'subagent' | 'unknown';
      uri: string;
    }>(`SELECT source_kind::text AS kind, source_uri AS uri FROM run_taint WHERE run_id = $1 ORDER BY created_at, id`, [runId]);
    return rows;
  }

  // ──────────────────────────────────────────────────────── the detail

  async ledger(client: pg.PoolClient, itemId: string): Promise<MemoryLedgerEntryView[]> {
    const { rows } = await client.query<{
      seq: string;
      action: string;
      detail: Record<string, unknown>;
      entry_hash: string;
      created_at: Date;
    }>(`SELECT seq::text AS seq, action, detail, entry_hash, created_at FROM memory_ledger WHERE item_id = $1 ORDER BY seq`, [
      itemId,
    ]);
    return rows.map((r) => ({
      seq: Number(r.seq),
      action: r.action,
      detail: r.detail,
      entryHash: r.entry_hash,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async confirmations(
    client: pg.PoolClient,
    itemId: string,
  ): Promise<
    {
      sourceKind: MemorySourceKind;
      sourceUri: string | null;
      createdAt: string;
    }[]
  > {
    const { rows } = await client.query<{
      source_kind: MemorySourceKind;
      source_uri: string | null;
      created_at: Date;
    }>(
      `SELECT source_kind::text AS source_kind, source_uri, created_at FROM memory_confirmations WHERE item_id = $1 ORDER BY created_at`,
      [itemId],
    );
    return rows.map((r) => ({
      sourceKind: r.source_kind,
      sourceUri: r.source_uri,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async derivations(
    client: pg.PoolClient,
    itemId: string,
  ): Promise<{
    sourceUris: string[];
    parents: { id: string; content: string }[];
    children: { id: string; content: string; state: MemoryStateName }[];
  }> {
    // One client runs one query at a time.
    const up = await client.query<{ source_uri: string }>(
      `SELECT source_uri FROM memory_derivations WHERE item_id = $1 AND source_uri IS NOT NULL ORDER BY created_at`,
      [itemId],
    );
    const parents = await client.query<{ id: string; content: string }>(
      `SELECT m.id, m.content FROM memory_derivations d JOIN memory_items m ON m.id = d.parent_item_id
          WHERE d.item_id = $1 ORDER BY d.created_at`,
      [itemId],
    );
    const children = await client.query<{
      id: string;
      content: string;
      state: MemoryStateName;
    }>(
      `SELECT m.id, m.content, m.state::text AS state FROM memory_derivations d JOIN memory_items m ON m.id = d.item_id
          WHERE d.parent_item_id = $1 ORDER BY d.created_at`,
      [itemId],
    );
    return {
      sourceUris: up.rows.map((r) => r.source_uri),
      parents: parents.rows,
      children: children.rows,
    };
  }

  async verifyLedger(client: pg.PoolClient): Promise<{ brokenSeq: number | null; checked: number }> {
    const { rows } = await client.query<{
      broken_seq: string | null;
      checked: string;
    }>(`SELECT * FROM app.memory_ledger_verify()`);
    return {
      brokenSeq: rows[0]?.broken_seq ? Number(rows[0].broken_seq) : null,
      checked: Number(rows[0]?.checked ?? 0),
    };
  }
}

// ──────────────────────────────────────────────────────────────── views

/** The trust a row holds now. */
export function trustOf(row: MemoryRow, now = new Date()): number {
  return currentTrust({
    tier: row.tier,
    ceiling: Number(row.trust_ceiling),
    sensitivity: row.sensitivity,
    since: row.last_reaffirmed_at ?? row.verified_at ?? row.created_at,
    now,
  });
}

export function memoryView(row: MemoryRow, now = new Date()): MemoryItemView {
  return {
    id: row.id,
    content: row.content,
    tier: row.tier,
    state: row.state,
    sourceKind: row.source_kind,
    sourceUri: row.source_uri,
    actor: row.actor,
    sensitivity: row.sensitivity,
    trust: Math.round((row.state === 'active' ? trustOf(row, now) : 0) * 1000) / 1000,
    trustCeiling: Number(row.trust_ceiling),
    confirmations: row.confirmations,
    reaffirmCount: row.reaffirm_count,
    operator: row.member_id === null,
    agentId: row.scope === 'agent' ? row.scope_ref : null,
    teamId: row.scope === 'team' ? row.scope_ref : null,
    stateReason: row.state_reason,
    verdict: row.verdict,
    createdAt: row.created_at.toISOString(),
    verifiedAt: row.verified_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
    demotedAt: row.demoted_at?.toISOString() ?? null,
    forgetRequestedAt: row.forget_requested_at?.toISOString() ?? null,
    forgetReason: row.forget_reason,
    flaggedWith: row.flagged_with,
  };
}
