import { describe, expect, it } from 'vitest';
import { pageQuerySchema, ulidSchema } from './primitives.js';

describe('ulidSchema', () => {
  it('accepts a well-formed ULID', () => {
    expect(ulidSchema.safeParse('01JBXR4K8ZQW3E7NDYVM5TGHPA').success).toBe(true);
  });

  it('rejects the excluded Crockford letters', () => {
    // I, L, O and U are excluded to avoid visual confusion with 1, 0 and V.
    expect(ulidSchema.safeParse('01JBXR4K8ZQW3E7NDYVM5TGHPI').success).toBe(false);
  });

  it('rejects a UUID', () => {
    expect(ulidSchema.safeParse('f47ac10b-58cc-4372-a567-0e02b2c3d479').success).toBe(false);
  });
});

describe('pageQuerySchema', () => {
  it('defaults the limit', () => {
    expect(pageQuerySchema.parse({})).toEqual({ limit: 25 });
  });

  it('caps the limit so one request cannot scan a tenant', () => {
    expect(pageQuerySchema.safeParse({ limit: 5000 }).success).toBe(false);
  });
});
