import { createHash } from 'node:crypto';
import type { Provenance } from './types.js';

/**
 * The hash that binds a memory's content to where it came from — the
 * tamper-evident anchor the ledger records (Agent 5.5 `store.evidence_hash`).
 * Keys in a fixed order, so the same claim from the same place hashes the same.
 */
export function evidenceHash(content: string, provenance: Provenance): string {
  const payload = JSON.stringify([
    content,
    provenance.sourceKind,
    provenance.sourceUri,
    provenance.conversationId,
    provenance.runId,
    provenance.actor,
  ]);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
