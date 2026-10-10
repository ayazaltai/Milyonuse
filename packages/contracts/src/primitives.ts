import { z } from 'zod';

/** Crockford base32, 26 chars — mirrors the `ulid` domain in 0001_foundation.sql. */
export const ulidSchema = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, 'expected a ULID');

export type Ulid = z.infer<typeof ulidSchema>;

/**
 * Cursor pagination. Offsets drift when rows are inserted mid-scroll and get
 * expensive deep into a history, so list endpoints are cursor-based.
 */
export const pageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

export interface Page<T> {
  items: T[];
  /** Cursor for the next page; null when this is the last one. */
  nextCursor: string | null;
}

/** Mutations accept this header so a retried request cannot double-apply. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const idempotencyKeySchema = z.string().min(8).max(255);
