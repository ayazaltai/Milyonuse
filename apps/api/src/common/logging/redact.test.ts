import { describe, expect, it } from 'vitest';
import { isSensitiveField, redact, scrub } from './redact.js';

describe('scrub', () => {
  it('masks an address wherever it sits in a message', () => {
    expect(scrub('550 5.1.1 <ada.lovelace+jobs@example.co.uk>: Recipient address rejected')).toBe(
      '550 5.1.1 <[email]>: Recipient address rejected',
    );
  });

  it('masks international and US-format phone numbers', () => {
    expect(scrub('call +1 (415) 555-0132 or +90 532 123 45 67')).toBe('call [phone] or [phone]');
    expect(scrub('home 415-555-0132, office (415) 555 0199')).toBe('home [phone], office [phone]');
  });

  it('leaves timestamps, ids, ports and counts alone', () => {
    const line = 'job 01J8Z3K2QW7M5N6P8R9S0T1V2X retried at 2026-09-24 10:15:00 on port 4000 after 3 attempts (1234567)';
    expect(scrub(line)).toBe(line);
  });

  it('masks credentials: bearer headers, JWTs, prefixed keys, signed URL parameters', () => {
    expect(scrub('Authorization: Bearer abc.def-123')).toBe('Authorization: Bearer [redacted]');
    expect(scrub('got eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toBe(
      'got [token]',
    );
    expect(scrub('key sk_live_abcdefghijklmnop rejected')).toBe('key [secret] rejected');
    expect(
      scrub('PUT https://b.s3.us-west-2.amazonaws.com/k?X-Amz-Credential=AKIA%2F&X-Amz-Signature=deadbeef&x=1'),
    ).toBe('PUT https://b.s3.us-west-2.amazonaws.com/k?X-Amz-Credential=[redacted]&X-Amz-Signature=[redacted]&x=1');
  });
});

describe('isSensitiveField', () => {
  it.each(['to', 'email', 'ownerEmail', 'owner_email', 'callbackToken', 'clientSecret', 'fullName', 'phone', 'Authorization'])(
    '%s is sensitive',
    (field) => expect(isSensitiveField(field)).toBe(true),
  );

  it.each(['organizationId', 'interviewId', 'kind', 'status', 'credentialRef', 'key', 'subject', 'count'])(
    '%s is not',
    (field) => expect(isSensitiveField(field)).toBe(false),
  );
});

describe('redact', () => {
  it('drops sensitive fields whole and scrubs every other string, at any depth', () => {
    expect(
      redact({
        to: 'ada@example.com',
        subject: 'Your interview',
        attempt: 2,
        nested: { ownerEmail: 'x@y.io', err: 'duplicate key for grace@example.org', list: ['+44 20 7946 0958', 5] },
        missing: null,
      }),
    ).toEqual({
      to: '[redacted]',
      subject: 'Your interview',
      attempt: 2,
      nested: { ownerEmail: '[redacted]', err: 'duplicate key for [email]', list: ['[phone]', 5] },
      missing: null,
    });
  });

  it('turns an Error into its scrubbed name, message and stack', () => {
    const out = redact({ err: new Error('no mailbox for ada@example.com') }) as { err: { message: string; stack: string } };
    expect(out.err.message).toBe('no mailbox for [email]');
    expect(out.err.stack).not.toContain('ada@example.com');
  });

  it('stops at a bounded depth', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 20; i++) cursor = cursor['next'] = {};
    expect(JSON.stringify(redact(deep))).toContain('[truncated]');
  });
});
