import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from './secret-box.js';

const key = (v: number) => `${v}:${randomBytes(32).toString('base64')}`;

describe('the secret box', () => {
  it('seals and opens, with a fresh IV each time', () => {
    const box = new SecretBox([key(1)]);
    const a = box.seal('refresh-token', 'connection:1');
    const b = box.seal('refresh-token', 'connection:1');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.toString('utf8')).not.toContain('refresh-token');
    expect(box.open(a, 'connection:1')).toBe('refresh-token');
  });

  it('refuses a ciphertext moved to another owner, or tampered with', () => {
    const box = new SecretBox([key(1)]);
    const sealed = box.seal('secret', 'connection:1');
    expect(() => box.open(sealed, 'connection:2')).toThrow();
    const flipped = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext.map((b, i) => (i === 0 ? b ^ 1 : b))) };
    expect(() => box.open(flipped, 'connection:1')).toThrow();
  });

  it('encrypts with the newest key and opens with any listed one — rotation', () => {
    const one = key(1);
    const old = new SecretBox([one]).seal('kept', 'c');
    const rotated = new SecretBox([one, key(2)]);
    expect(rotated.current).toBe(2);
    expect(rotated.open(old, 'c')).toBe('kept');
    expect(rotated.seal('new', 'c').keyVersion).toBe(2);
    expect(() => new SecretBox([key(3)]).open(old, 'c')).toThrow(/No key 1/);
  });

  it('signs with a key derived per purpose, never the encryption key', () => {
    const box = new SecretBox([key(1)]);
    expect(box.sign('provenance', 'x')).toBe(box.sign('provenance', 'x'));
    expect(box.sign('provenance', 'x')).not.toBe(box.sign('oauth', 'x'));
  });
});
