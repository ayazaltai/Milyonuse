import { describe, expect, it } from 'vitest';
import { registerInputSchema, timeZoneSchema, updateProfileSchema } from './account.js';

describe('registerInputSchema', () => {
  const valid = {
    name: 'Ada',
    email: '  Ada@Example.COM ',
    password: 'correct horse battery',
    acceptTerms: true,
  };

  it('normalises the address so mail, rate limit and storage agree', () => {
    expect(registerInputSchema.parse(valid).email).toBe('ada@example.com');
  });

  it('defaults language and time zone', () => {
    const parsed = registerInputSchema.parse(valid);
    expect(parsed.locale).toBe('en');
    expect(parsed.timeZone).toBe('UTC');
  });

  it('requires the terms to be accepted', () => {
    expect(registerInputSchema.safeParse({ ...valid, acceptTerms: false }).success).toBe(false);
  });

  it('refuses a short password up front', () => {
    expect(registerInputSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false);
  });

  it('refuses a language the product does not ship in', () => {
    expect(registerInputSchema.safeParse({ ...valid, locale: 'fr' }).success).toBe(false);
  });
});

describe('timeZoneSchema', () => {
  it('accepts IANA names', () => {
    expect(timeZoneSchema.safeParse('Europe/Istanbul').success).toBe(true);
    expect(timeZoneSchema.safeParse('America/Argentina/Buenos_Aires').success).toBe(true);
  });

  it('refuses anything that could not be one', () => {
    expect(timeZoneSchema.safeParse("UTC'; DROP").success).toBe(false);
  });
});

describe('updateProfileSchema', () => {
  it('refuses an empty change', () => {
    expect(updateProfileSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a single field', () => {
    expect(updateProfileSchema.parse({ locale: 'tr' })).toEqual({ locale: 'tr' });
  });
});
