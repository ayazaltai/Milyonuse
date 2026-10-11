import { ErrorCode } from '@milyonuse/contracts';
import { AppError } from '../../common/app-error.js';

interface PgError {
  code?: string;
  hint?: string | null;
  constraint?: string | null;
  message?: string;
}

/**
 * Turns a database-enforced rule into the API's error contract.
 *
 * The rules themselves live in SQL — the last-owner protection, append-only
 * records, state machines — so they hold for every caller. The price is that
 * violations arrive as Postgres exceptions, and something has to map them back
 * to a machine-readable code the client can branch on. That is this function,
 * and it is the only place that knows both vocabularies.
 *
 * Each rule raises with an explicit HINT for exactly this purpose; matching on
 * message text would break the first time an error string is reworded.
 */
const BY_HINT: Record<string, { code: ErrorCode; message: string }> = {
  // 0002 identity
  time_zone_unknown: {
    code: ErrorCode.VALIDATION_FAILED,
    message: 'Choose a time zone from the list.',
  },
  organization_identity_fixed: {
    code: ErrorCode.CONFLICT,
    message: 'What a workspace is, and who opened it, does not change.',
  },
  personal_organization_single_member: {
    code: ErrorCode.CONFLICT,
    message: 'A personal workspace belongs to its owner alone.',
  },
  last_owner_protected: {
    code: ErrorCode.CONFLICT,
    message: 'At least one active owner must remain. Make someone else an owner first.',
  },
  // 0003 sessions
  session_fixed: {
    code: ErrorCode.CONFLICT,
    message: 'That session has already ended.',
  },
  // 0004 audit
  audit_log_immutable: {
    code: ErrorCode.PERMISSION_DENIED,
    message: 'The audit log cannot be changed.',
  },
  // 0005 platform
  idempotency_record_fixed: {
    code: ErrorCode.CONFLICT,
    message: 'That request has already been answered.',
  },
  job_finished: {
    code: ErrorCode.CONFLICT,
    message: 'That job has already finished.',
  },
  system_log_immutable: {
    code: ErrorCode.CONFLICT,
    message: 'A system log line cannot be changed.',
  },
  // 0006 agent core
  agent_revision_invalid: {
    code: ErrorCode.CONFLICT,
    message: 'Only your own message in the same conversation can be revised.',
  },
  agent_message_immutable: {
    code: ErrorCode.CONFLICT,
    message: 'A message cannot be changed once it is written.',
  },
  agent_summary_boundary: {
    code: ErrorCode.CONFLICT,
    message: 'The conversation changed while it was being summarised. Try again.',
  },
  agent_feedback_invalid: {
    code: ErrorCode.VALIDATION_FAILED,
    message: 'Feedback can only be given on an answer from the agent.',
  },
  usage_only_grows: {
    code: ErrorCode.CONFLICT,
    message: 'Recorded usage cannot be reduced.',
  },
  // 0007 memory
  memory_direct_write: {
    code: ErrorCode.CONFLICT,
    message: 'A memory starts as a candidate and is verified before it is kept.',
  },
  memory_tier_exceeds_source: {
    code: ErrorCode.CONFLICT,
    message: 'A memory cannot be trusted more than the source it came from.',
  },
  memory_provenance_immutable: {
    code: ErrorCode.CONFLICT,
    message: 'What a memory says, and where it came from, does not change.',
  },
  memory_transition_invalid: {
    code: ErrorCode.CONFLICT,
    message: 'That memory cannot move to that state.',
  },
  memory_confirmations_required: {
    code: ErrorCode.CONFLICT,
    message: 'A claim from an outside source needs two independent confirmations first.',
  },
  memory_approval_required: {
    code: ErrorCode.CONFLICT,
    message: 'Only you can approve this memory.',
  },
  memory_repromotion_requires_evidence: {
    code: ErrorCode.CONFLICT,
    message: 'A demoted memory comes back only with new evidence.',
  },
  memory_t0_review: {
    code: ErrorCode.CONFLICT,
    message: 'An operator memory is activated with a second signature, after its review period.',
  },
  memory_confirmation_not_independent: {
    code: ErrorCode.CONFLICT,
    message: 'A confirmation must come from other evidence and another source.',
  },
  memory_ledger_immutable: {
    code: ErrorCode.PERMISSION_DENIED,
    message: 'The memory ledger cannot be changed.',
  },
};

const BY_CONSTRAINT: Record<string, { code: ErrorCode; message: string }> = {
  organizations_one_personal: {
    code: ErrorCode.CONFLICT,
    message: 'This account already has a personal workspace.',
  },
};

export function translateDatabaseError(error: unknown): AppError | null {
  const pgError = error as PgError | null;
  if (!pgError || typeof pgError !== 'object') return null;

  const byHint = pgError.hint ? BY_HINT[pgError.hint] : undefined;
  if (byHint) {
    return new AppError(byHint.code, byHint.message, { cause: error });
  }

  const byConstraint = pgError.constraint ? BY_CONSTRAINT[pgError.constraint] : undefined;
  if (byConstraint) {
    return new AppError(byConstraint.code, byConstraint.message, { cause: error });
  }

  // 23505 unique_violation with no mapping above: a genuine conflict, but one
  // whose detail would expose column names, so it stays generic.
  if (pgError.code === '23505') {
    return new AppError(ErrorCode.CONFLICT, 'That record already exists.', { cause: error });
  }

  return null;
}

/** Rethrows a database rule violation as an AppError, or the original error. */
export function rethrowDatabaseError(error: unknown): never {
  throw translateDatabaseError(error) ?? error;
}
