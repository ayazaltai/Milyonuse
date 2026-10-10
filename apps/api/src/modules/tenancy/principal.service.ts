import { Injectable } from '@nestjs/common';
import { ErrorCode, type MemberRole, type OrganizationKind, type Principal } from '@milyonuse/contracts';
import { AppError } from '../../common/app-error.js';
import { TenantScope } from './tenant-scope.service.js';

interface PrincipalRow {
  member_id: string;
  role: MemberRole;
  member_status: 'active' | 'deactivated';
  organization_kind: OrganizationKind;
  organization_status: 'active' | 'suspended' | 'closed';
}

/**
 * Builds the authenticated caller's Principal.
 *
 * Everything here is resolved server-side from the session. Nothing is read
 * from the request body or from a header the client controls — an organization
 * id supplied by the caller is a claim, not an authorisation, and treating it
 * as one is how multi-tenant systems leak.
 */
@Injectable()
export class PrincipalService {
  constructor(private readonly scope: TenantScope) {}

  async resolve(userId: string, organizationId: string): Promise<Principal> {
    return this.scope.run(organizationId, async (client) => {
      // The membership and its organization in one read — this runs on every
      // signed-in request.
      const { rows } = await client.query<PrincipalRow>(
        `SELECT m.id     AS member_id,
                m.role   AS role,
                m.status AS member_status,
                o.kind   AS organization_kind,
                o.status AS organization_status
         FROM members m
         JOIN organizations o ON o.id = m.organization_id
         WHERE m.user_id = $1`,
        [userId],
      );

      const row = rows[0];
      if (!row) {
        // The membership does not exist, or RLS hid it because this person
        // belongs to a different tenant. Both are "not a member here", and
        // saying which would confirm the organization exists.
        throw new AppError(ErrorCode.ORGANIZATION_NOT_FOUND, 'No membership for this organization.');
      }
      if (row.member_status === 'deactivated') {
        throw new AppError(ErrorCode.MEMBER_DEACTIVATED, 'This account has been deactivated here.');
      }
      if (row.organization_status !== 'active') {
        throw new AppError(ErrorCode.ORGANIZATION_SUSPENDED, 'This workspace is not active.');
      }

      return {
        userId,
        organizationId,
        organizationKind: row.organization_kind,
        memberId: row.member_id,
        role: row.role,
      };
    });
  }
}
