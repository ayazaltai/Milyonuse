import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ErrorCode, type Principal } from '@milyonuse/contracts';
import type pg from 'pg';
import { AppError } from '../../../common/app-error.js';
import { TenantScope } from '../../tenancy/tenant-scope.service.js';
import { withoutControls } from './writers.js';

export interface StoredFile {
  id: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
  expiresAt: string;
}

/** Files the agent made (agent_files, 0009): one person's, kept for 30 days. */
@Injectable()
export class FileStore {
  constructor(private readonly scope: TenantScope) {}

  async save(
    principal: Pick<Principal, 'organizationId' | 'memberId'>,
    input: { conversationId: string; name: string; contentType: string; bytes: Buffer; source: 'file_create' | 'code_run' },
  ): Promise<StoredFile> {
    if (input.bytes.length === 0) throw new AppError(ErrorCode.VALIDATION_FAILED, 'The file is empty.');
    if (input.bytes.length > 10 * 1024 * 1024) throw new AppError(ErrorCode.VALIDATION_FAILED, 'A file the agent makes is at most 10 MB.');
    const name = safeName(input.name);
    return this.scope.run({ organizationId: principal.organizationId, memberId: principal.memberId }, async (client) => {
      const { rows } = await client.query<{ id: string; size: number; expires_at: Date }>(
        `INSERT INTO agent_files (organization_id, member_id, conversation_id, name, content_type, bytes, sha256, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, size, expires_at`,
        [
          principal.organizationId,
          principal.memberId,
          input.conversationId,
          name,
          input.contentType,
          input.bytes,
          createHash('sha256').update(input.bytes).digest('hex'),
          input.source,
        ],
      );
      const row = rows[0]!;
      return { id: row.id, name, contentType: input.contentType, size: row.size, url: `/api/v1/agent/files/${row.id}`, expiresAt: row.expires_at.toISOString() };
    });
  }

  async read(principal: Principal, id: string): Promise<{ name: string; contentType: string; bytes: Buffer }> {
    return this.scope.run({ organizationId: principal.organizationId, memberId: principal.memberId }, async (client: pg.PoolClient) => {
      const { rows } = await client.query<{ name: string; content_type: string; bytes: Buffer }>(
        `SELECT name, content_type, bytes FROM agent_files WHERE id = $1 AND expires_at > now()`,
        [id],
      );
      if (!rows[0]) throw AppError.notFound('File');
      return { name: rows[0].name, contentType: rows[0].content_type, bytes: rows[0].bytes };
    });
  }
}

/** A name the database and a download dialog both accept: no path, no control characters. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = withoutControls(base).replace(/^\.+/, '').trim().slice(0, 120);
  return clean || 'file';
}
