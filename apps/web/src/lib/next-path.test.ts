import { describe, expect, it } from 'vitest';
import { safeNext } from './next-path';

describe('safeNext', () => {
  it('keeps a path of this site', () => {
    expect(safeNext('/app/settings/profile')).toBe('/app/settings/profile');
    expect(safeNext('/app?tab=1')).toBe('/app?tab=1');
  });

  it('refuses anything that leaves the site', () => {
    for (const value of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '', null]) {
      expect(safeNext(value)).toBeNull();
    }
  });
});
