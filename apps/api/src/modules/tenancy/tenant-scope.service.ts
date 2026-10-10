import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { APP_POOL } from '../../database/database.module.js';

/**
 * The `ulid` domain's own check (0001_foundation.sql). An id that does not
 * match it names nothing.
 */
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Who the scope is for. A bare organization id is the common case. */
export type ScopeTarget = string | { organizationId: string; memberId?: string | undefined };

/**
 * The only sanctioned way to touch tenant data.
 *
 * Opens a transaction, binds app.organization_id (and, when known,
 * app.member_id) to it with SET LOCAL semantics, and hands back a client.
 * Row-level policies read those settings; when they are unset they match
 * nothing, so a query that skips this helper returns empty rather than
 * returning everyone's rows.
 *
 * Transaction-local rather than session-wide: the setting dies with the
 * transaction and cannot survive into the next checkout of a pooled
 * connection.
 */
@Injectable()
export class TenantScope {
  constructor(@Inject(APP_POOL) private readonly pool: pg.Pool) {}

  async run<T>(target: ScopeTarget, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const { organizationId, memberId } = typeof target === 'string' ? { organizationId: target } : target;

    // One round trip opens the scope, not two: BEGIN and the settings travel
    // as one simple-protocol message, and a scope opens on every request. That
    // protocol takes no parameters, so the ids go in as literals — only after
    // they have matched the ulid domain's own pattern, which admits no
    // character a literal could be broken out of, and escaped regardless.
    if (!ULID.test(organizationId)) {
      throw new Error('A tenant scope needs an organization id.');
    }
    if (memberId !== undefined && !ULID.test(memberId)) {
      throw new Error('A member in a tenant scope is named by its id.');
    }

    const client = await this.pool.connect();
    let broken = false;
    try {
      const member = memberId
        ? `, set_config('app.member_id', ${client.escapeLiteral(memberId)}, true)`
        : '';
      await client.query(
        `BEGIN; SELECT set_config('app.organization_id', ${client.escapeLiteral(organizationId)}, true)${member}`,
      );
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      // A connection that cannot even roll back is broken; it is discarded
      // rather than handed to the next request.
      broken = await client.query('ROLLBACK').then(
        () => false,
        () => true,
      );
      throw error;
    } finally {
      client.release(broken);
    }
  }
}
