import { z } from 'zod';
import { ulidSchema } from './primitives.js';

/**
 * Who is acting, and in which organization.
 *
 * In a personal organization the person is its owner and there is nothing
 * else to say. A shared organization (Phase 9) adds admins and members; the
 * rules for what each may do live in `can()` below, in one place.
 */

export const memberRoleSchema = z.enum(['owner', 'admin', 'member']);
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const memberStatusSchema = z.enum(['active', 'deactivated']);
export type MemberStatus = z.infer<typeof memberStatusSchema>;

export const organizationKindSchema = z.enum(['personal', 'shared']);
export type OrganizationKind = z.infer<typeof organizationKindSchema>;

export const principalSchema = z.object({
  userId: ulidSchema,
  /** Resolved from the session, never from the request body. */
  organizationId: ulidSchema,
  organizationKind: organizationKindSchema,
  memberId: ulidSchema,
  role: memberRoleSchema,
});
export type Principal = z.infer<typeof principalSchema>;

/**
 * Everything a member may be allowed to do, by name. A route that changes
 * something names the permission it needs; nothing checks roles directly.
 */
export const PERMISSIONS = [
  'organization.read',
  'organization.manage',
  'members.manage',
  'agents.use',
  'agents.manage',
  'automations.manage',
  'billing.manage',
  'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const GRANTS: Record<MemberRole, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: [
    'organization.read',
    'members.manage',
    'agents.use',
    'agents.manage',
    'automations.manage',
    'audit.read',
  ],
  member: ['organization.read', 'agents.use', 'agents.manage', 'automations.manage'],
};

export function can(principal: Pick<Principal, 'role'>, permission: Permission): boolean {
  return GRANTS[principal.role].includes(permission);
}
