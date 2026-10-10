/**
 * The error contract.
 *
 * Every failure crossing the API boundary carries a stable machine-readable
 * `code`. Clients branch on the code; the `message` is for humans and may be
 * reworded at any time. Adding a code is a contract change and belongs in a
 * pull request, not in a catch block.
 */

export const ErrorCode = {
  // --- request shape
  VALIDATION_FAILED: 'validation_failed',
  MALFORMED_REQUEST: 'malformed_request',

  // --- identity
  UNAUTHENTICATED: 'unauthenticated',
  SESSION_EXPIRED: 'session_expired',
  /** The address and password do not match an account. Which of the two is wrong is not said. */
  INVALID_CREDENTIALS: 'invalid_credentials',
  /** Registration is switched off on this deployment (SIGNUP_ENABLED). */
  SIGNUP_CLOSED: 'signup_closed',
  /** A sensitive change needs the current password, and the one given is not it. */
  REAUTHENTICATION_FAILED: 'reauthentication_failed',

  // --- tenancy
  MEMBER_DEACTIVATED: 'member_deactivated',
  ORGANIZATION_NOT_FOUND: 'organization_not_found',
  ORGANIZATION_SUSPENDED: 'organization_suspended',
  PERMISSION_DENIED: 'permission_denied',

  // --- resources
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  IDEMPOTENCY_KEY_REUSED: 'idempotency_key_reused',

  // --- flow control
  RATE_LIMITED: 'rate_limited',
  INTERNAL_ERROR: 'internal_error',
  SERVICE_UNAVAILABLE: 'service_unavailable',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorBody {
  /** Stable, machine-readable. Clients branch on this. */
  code: ErrorCode;
  /** Human-readable. Never parsed by clients. */
  message: string;
  /** Field-level detail for validation failures. */
  details?: { path: string; message: string }[];
  /** Correlates the response with server logs and traces. */
  requestId: string;
}

export interface ErrorResponse {
  error: ErrorBody;
}

/** HTTP status for each code — one place, so a code cannot drift between routes. */
export const errorStatus: Record<ErrorCode, number> = {
  [ErrorCode.VALIDATION_FAILED]: 422,
  [ErrorCode.MALFORMED_REQUEST]: 400,

  [ErrorCode.UNAUTHENTICATED]: 401,
  [ErrorCode.SESSION_EXPIRED]: 401,
  [ErrorCode.INVALID_CREDENTIALS]: 401,
  [ErrorCode.SIGNUP_CLOSED]: 403,
  [ErrorCode.REAUTHENTICATION_FAILED]: 403,

  [ErrorCode.MEMBER_DEACTIVATED]: 403,
  [ErrorCode.ORGANIZATION_NOT_FOUND]: 404,
  [ErrorCode.ORGANIZATION_SUSPENDED]: 403,
  [ErrorCode.PERMISSION_DENIED]: 403,

  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: 409,

  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.SERVICE_UNAVAILABLE]: 503,
};
