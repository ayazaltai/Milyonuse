import { Injectable } from '@nestjs/common';
import { type Me, type Principal, type UpdateProfile, isLocale } from '@milyonuse/contracts';
import { AppError } from '../../common/app-error.js';
import { AuditService } from '../tenancy/audit.service.js';
import { rethrowDatabaseError } from '../tenancy/database-error.js';
import { TenantScope } from '../tenancy/tenant-scope.service.js';

interface MeRow {
  user_id: string;
  email: string;
  name: string;
  locale: string;
  time_zone: string;
  user_created_at: Date;
  organization_id: string;
  organization_name: string;
  organization_kind: 'personal' | 'shared';
  member_id: string;
  role: 'owner' | 'admin' | 'member';
}

/**
 * The signed-in person's own record: who they are, the organization they are
 * in, and the profile they may edit. Read and written in their organization's
 * scope — the users policy (0002) shows a person to the organizations they
 * belong to, and to nobody else.
 */
@Injectable()
export class ProfileService {
  constructor(
    private readonly scope: TenantScope,
    private readonly audit: AuditService,
  ) {}

  async me(principal: Principal): Promise<Me> {
    return this.scope.run(principal.organizationId, async (client) => {
      const { rows } = await client.query<MeRow>(
        `SELECT u.id AS user_id, u.email, u.name, u.locale, u.time_zone, u.created_at AS user_created_at,
                o.id AS organization_id, o.name AS organization_name, o.kind AS organization_kind,
                m.id AS member_id, m.role
           FROM members m
           JOIN users u ON u.id = m.user_id
           JOIN organizations o ON o.id = m.organization_id
          WHERE m.id = $1`,
        [principal.memberId],
      );
      const row = rows[0];
      if (!row) throw AppError.notFound('Account');
      return {
        user: {
          id: row.user_id,
          email: row.email,
          name: row.name,
          locale: isLocale(row.locale) ? row.locale : 'en',
          timeZone: row.time_zone,
          createdAt: row.user_created_at.toISOString(),
        },
        organization: { id: row.organization_id, name: row.organization_name, kind: row.organization_kind },
        member: { id: row.member_id, role: row.role },
      };
    });
  }

  /** Changes what the person sent, records before and after, and answers with the new record. */
  async update(principal: Principal, change: UpdateProfile): Promise<Me> {
    try {
      await this.scope.run(principal.organizationId, async (client) => {
        const { rows } = await client.query<{ name: string; locale: string; time_zone: string }>(
          `SELECT name, locale, time_zone FROM users WHERE id = $1 FOR UPDATE`,
          [principal.userId],
        );
        const before = rows[0];
        if (!before) throw AppError.notFound('Account');

        await client.query(
          `UPDATE users
              SET name = COALESCE($2, name),
                  locale = COALESCE($3, locale),
                  time_zone = COALESCE($4, time_zone)
            WHERE id = $1`,
          [principal.userId, change.name ?? null, change.locale ?? null, change.timeZone ?? null],
        );
        await this.audit.record(client, {
          organizationId: principal.organizationId,
          actorMemberId: principal.memberId,
          action: 'user.profile_changed',
          resourceType: 'user',
          resourceId: principal.userId,
          before: { name: before.name, locale: before.locale, timeZone: before.time_zone },
          after: change,
        });
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      rethrowDatabaseError(error);
    }
    return this.me(principal);
  }
}
