import { ErrorCode, errorStatus } from '@milyonuse/contracts';

/**
 * The only exception type this codebase throws deliberately.
 *
 * Carrying the ErrorCode rather than an HTTP status keeps the status mapping in
 * one table (@milyonuse/contracts), so the same failure cannot answer 403 on one
 * route and 404 on another.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: { path: string; message: string }[];
  /** Context for logs only. Never serialised into a response. */
  readonly context?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      details?: { path: string; message: string }[];
      context?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = errorStatus[code];
    if (options?.details) this.details = options.details;
    if (options?.context) this.context = options.context;
  }

  static notFound(what: string): AppError {
    return new AppError(ErrorCode.NOT_FOUND, `${what} not found`);
  }

  static permissionDenied(reason = 'Insufficient permissions'): AppError {
    return new AppError(ErrorCode.PERMISSION_DENIED, reason);
  }

}
