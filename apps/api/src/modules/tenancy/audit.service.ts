import { Injectable } from '@nestjs/common';
import type pg from 'pg';
import { requestContext } from '../../common/logging/logger.js';

export interface AuditEntryInput {
  organizationId: string;
  action: string;
  resourceType: string;
  resourceId?: string | undefined;
  actorMemberId?: string | undefined;
  actorType?: 'member' | 'agent' | 'system';
  before?: unknown;
  after?: unknown;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * Writes the audit trail.
 *
 * Deliberately takes a client rather than opening its own transaction: an audit
 * entry is written in the same transaction as the change it describes. If the
 * change rolls back the entry goes with it, and there is no window where the
 * log claims something that did not happen — or misses something that did.
 */
@Injectable()
export class AuditService {
  async record(client: pg.PoolClient, entry: AuditEntryInput): Promise<void> {
    await client.query(
      `INSERT INTO audit_log (
         organization_id, actor_member_id, actor_type,
         action, resource_type, resource_id,
         before, after, ip, user_agent, request_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        entry.organizationId,
        entry.actorMemberId ?? null,
        entry.actorType ?? 'member',
        entry.action,
        entry.resourceType,
        entry.resourceId ?? null,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        entry.ip ?? null,
        entry.userAgent?.slice(0, 512) ?? null,
        requestContext.getStore()?.requestId ?? null,
      ],
    );
  }
}
