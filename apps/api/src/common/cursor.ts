import { ErrorCode, ulidSchema } from '@milyonuse/contracts';
import { AppError } from './app-error.js';

/**
 * Keyset pagination over ULID primary keys.
 *
 * A ULID sorts by the moment it was made, so "everything older than this id"
 * is the next page: stable while new rows arrive mid-scroll, and as cheap on
 * page two hundred as on page one. The cursor is simply the last id seen.
 */
export function cursorId(cursor: string | undefined): string | null {
  if (!cursor) return null;
  const parsed = ulidSchema.safeParse(cursor);
  if (!parsed.success) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, 'That page cursor is not valid.');
  }
  return parsed.data;
}

/** Takes `limit + 1` rows and returns one page and whether there is another. */
export function page<T>(rows: T[], limit: number, idOf: (row: T) => string): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  return { items, nextCursor: idOf(items[items.length - 1]!) };
}
