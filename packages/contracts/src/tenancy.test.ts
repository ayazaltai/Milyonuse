import { describe, expect, it } from 'vitest';
import { PERMISSIONS, can } from './tenancy.js';

describe('can()', () => {
  it('lets an owner do everything', () => {
    for (const permission of PERMISSIONS) expect(can({ role: 'owner' }, permission)).toBe(true);
  });

  it('keeps billing and organization management with the owner', () => {
    expect(can({ role: 'admin' }, 'billing.manage')).toBe(false);
    expect(can({ role: 'admin' }, 'organization.manage')).toBe(false);
    expect(can({ role: 'member' }, 'members.manage')).toBe(false);
  });

  it('lets every member use and build agents', () => {
    expect(can({ role: 'member' }, 'agents.use')).toBe(true);
    expect(can({ role: 'member' }, 'agents.manage')).toBe(true);
  });
});
