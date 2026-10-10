import { createHash } from 'node:crypto';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
  UseInterceptors,
  applyDecorators,
} from '@nestjs/common';
import { ErrorCode } from '@milyonuse/contracts';
import type { FastifyReply } from 'fastify';
import type pg from 'pg';
import { type Observable, catchError, concatMap, from, map, of, throwError } from 'rxjs';
import { AppError } from '../../common/app-error.js';
import { AppLogger } from '../../common/logging/logger.js';
import type { RequestWithPrincipal } from './guards/principal.decorator.js';
import { TenantScope } from './tenant-scope.service.js';

/**
 * The Idempotency-Key header (0005).
 *
 * Optional, as the standard has it: a request without the header runs as it
 * always did. With it, the first request under a key runs and its answer is
 * recorded; a repeat — same member, same key, same request — gets that answer
 * back, marked `Idempotent-Replayed: true`, and runs nothing.
 *
 * Only a success is recorded. A refusal changed nothing, so the key is
 * released and a retry runs again. A request that started and never answered
 * keeps its key and a retry is refused — running it again could be the very
 * duplicate the key exists to prevent, so the client is told to check first.
 *
 * Routes opt in with `@Idempotent()`. A POST that a member can call must say
 * one or the other — `@Idempotent()` or `@IdempotencyExempt(reason)` — and the
 * route inventory test fails a route that says neither.
 */

/** Exported for the route inventory (docs/api/routes.md). */
export const IDEMPOTENT_KEY = 'milyonuse:idempotent';
export const IDEMPOTENCY_EXEMPT_KEY = 'milyonuse:idempotency-exempt';

const HEADER = 'idempotency-key';
/** Visible ASCII, 1–255 characters: a UUID, a ULID, a client's own request id. */
const KEY_FORMAT = /^[\x21-\x7e]{1,255}$/;

interface KeyRecord {
  organizationId: string;
  memberId: string;
  key: string;
  requestHash: string;
}

type Claim =
  | { kind: 'claimed' }
  | { kind: 'existing'; requestHash: string; completed: boolean; body: unknown };

/** Order-independent JSON, so `{a, b}` and `{b, a}` are the same request. */
function canonical(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return createHash('sha256').update(value).digest('hex');
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** What makes two requests the same request: method, path with its query, and body. */
export function requestFingerprint(method: string, url: string, body: unknown): string {
  const shape = JSON.stringify(canonical({ method, url, body: body ?? null }));
  return createHash('sha256').update(shape).digest('hex');
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly scope: TenantScope,
    private readonly logger: AppLogger,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithPrincipal>();

    const header = request.headers[HEADER];
    if (header === undefined) return next.handle();
    if (typeof header !== 'string' || !KEY_FORMAT.test(header)) {
      throw new AppError(
        ErrorCode.MALFORMED_REQUEST,
        'Idempotency-Key must be 1 to 255 visible ASCII characters.',
      );
    }

    const principal = request.principal;
    if (!principal) {
      // A key belongs to a member; a route without a principal cannot keep one.
      throw new Error('@Idempotent() used on a route without PrincipalGuard');
    }

    const record: KeyRecord = {
      organizationId: principal.organizationId,
      memberId: principal.memberId,
      key: header,
      requestHash: requestFingerprint(request.method, request.url, request.body),
    };

    const claim = await this.claim(record);

    if (claim.kind === 'claimed') {
      return next.handle().pipe(
        // Only the handler's own failure releases the key: it changed nothing.
        catchError((error: unknown) =>
          from(this.release(record)).pipe(concatMap(() => throwError(() => error))),
        ),
        concatMap((body: unknown) => from(this.answer(record, body)).pipe(map(() => body))),
      );
    }

    if (claim.requestHash !== record.requestHash) {
      throw new AppError(
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
        'This Idempotency-Key was already used for a different request.',
      );
    }
    if (!claim.completed) {
      throw new AppError(
        ErrorCode.CONFLICT,
        'A request with this Idempotency-Key has not finished. If it was interrupted, check whether it took effect before retrying with a new key.',
      );
    }

    void http.getResponse<FastifyReply>().header('idempotent-replayed', 'true');
    return of(claim.body);
  }

  private async claim(record: KeyRecord): Promise<Claim> {
    return this.scope.run(record.organizationId, async (client) => {
      // An expired key is a fresh key, and this member's other expired records
      // go with it.
      await client.query(
        `DELETE FROM idempotency_keys
         WHERE organization_id = $1 AND member_id = $2 AND expires_at <= now()`,
        [record.organizationId, record.memberId],
      );

      const inserted = await client.query(
        `INSERT INTO idempotency_keys (organization_id, member_id, key, request_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [record.organizationId, record.memberId, record.key, record.requestHash],
      );
      if (inserted.rowCount === 1) return { kind: 'claimed' };

      const { rows } = await client.query<{
        request_hash: string;
        completed: boolean;
        response_body: unknown;
      }>(
        `SELECT request_hash, completed_at IS NOT NULL AS completed, response_body
         FROM idempotency_keys
         WHERE organization_id = $1 AND member_id = $2 AND key = $3`,
        [record.organizationId, record.memberId, record.key],
      );
      const row = rows[0];
      // Released between the two statements by a request that just failed:
      // answer as in progress rather than guess.
      if (!row)
        return { kind: 'existing', requestHash: record.requestHash, completed: false, body: null };
      return {
        kind: 'existing',
        requestHash: row.request_hash,
        completed: row.completed,
        body: row.response_body,
      };
    });
  }

  /**
   * Records the answer. A failure here does not fail the response — the work
   * is done and the client should hear so. The key simply stays unanswered,
   * and a retry is refused rather than run twice.
   */
  private async answer(record: KeyRecord, body: unknown): Promise<void> {
    try {
      await this.scope.run(record.organizationId, (client) =>
        client.query(
          // Serialised explicitly: the driver would send an array as a
          // Postgres array, not as JSON.
          `UPDATE idempotency_keys SET completed_at = now(), response_body = $4::jsonb
           WHERE organization_id = $1 AND member_id = $2 AND key = $3`,
          [record.organizationId, record.memberId, record.key, JSON.stringify(body ?? null)],
        ),
      );
    } catch (error) {
      this.logger.error('idempotency answer not recorded', {
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async release(record: KeyRecord): Promise<void> {
    try {
      await this.scope.run(record.organizationId, (client) =>
        client.query(
          `DELETE FROM idempotency_keys
           WHERE organization_id = $1 AND member_id = $2 AND key = $3 AND completed_at IS NULL`,
          [record.organizationId, record.memberId, record.key],
        ),
      );
    } catch (error) {
      this.logger.error('idempotency key not released', {
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Honours an Idempotency-Key on this route. */
export const Idempotent = () =>
  applyDecorators(SetMetadata(IDEMPOTENT_KEY, true), UseInterceptors(IdempotencyInterceptor));

/**
 * Deliberately does not honour one — with the reason, which the route
 * inventory prints. For a response that must never be stored (a secret, a
 * person's whole record) or a request that is harmless to repeat.
 */
export const IdempotencyExempt = (reason: string) => SetMetadata(IDEMPOTENCY_EXEMPT_KEY, reason);

/**
 * Removes records past their day, across tenants — housekeeping the retention
 * worker runs hourly on the platform pool. Bounded per call so a backlog
 * drains over several ticks rather than in one long statement.
 */
export async function purgeExpiredIdempotencyKeys(platform: pg.Pool): Promise<number> {
  const { rowCount } = await platform.query(
    `DELETE FROM idempotency_keys
     WHERE ctid IN (SELECT ctid FROM idempotency_keys WHERE expires_at <= now() LIMIT 10000)`,
  );
  return rowCount ?? 0;
}
