import { describe, expect, it } from 'vitest';
import { fingerprint, generateOperatorKeyPair, signMessage, verifyOperator } from './operator.js';

describe('operator signatures', () => {
  const operator = generateOperatorKeyPair();
  const other = generateOperatorKeyPair();

  it('verify against the operator’s key and name it', () => {
    const signature = signMessage(operator.privateKeyPem, 'Never share passwords');
    expect(verifyOperator([other.publicKeyPem, operator.publicKeyPem], 'Never share passwords', signature)).toBe(
      fingerprint(operator.publicKeyPem),
    );
  });

  it('refuse another message, another key, or no key', () => {
    const signature = signMessage(operator.privateKeyPem, 'Never share passwords');
    expect(verifyOperator([operator.publicKeyPem], 'Always share passwords', signature)).toBeNull();
    expect(verifyOperator([other.publicKeyPem], 'Never share passwords', signature)).toBeNull();
    expect(verifyOperator([], 'Never share passwords', signature)).toBeNull();
  });

  it('fail closed on anything malformed', () => {
    expect(verifyOperator([operator.publicKeyPem], 'x', 'not base64!')).toBeNull();
    expect(verifyOperator([operator.publicKeyPem], 'x', Buffer.from('short').toString('base64'))).toBeNull();
    expect(verifyOperator(['-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----'], 'x', 'A'.repeat(88))).toBeNull();
  });

  it('name a key the same way every time', () => {
    expect(fingerprint(operator.publicKeyPem)).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(fingerprint(operator.publicKeyPem)).toBe(fingerprint(operator.publicKeyPem));
    expect(fingerprint(operator.publicKeyPem)).not.toBe(fingerprint(other.publicKeyPem));
  });
});
