import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { Env } from '../config/env.js';

/**
 * Secrets at rest (F3 §3): AES-256-GCM, a fresh 96-bit IV each time, and what
 * the secret belongs to bound in as associated data — a ciphertext copied to
 * another connection's row does not decrypt there.
 *
 * Keys come from SECRETS_KEYS as `version:base64`; the highest version
 * encrypts, every listed one decrypts, so rotating is adding the next key and
 * re-encrypting at leisure. Development and tests use a fixed stand-in key the
 * API refuses in production (config/env.ts).
 */

export interface Sealed {
  keyVersion: number;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

const DEVELOPMENT_KEY = hkdfSync('sha256', 'milyonuse-development-only', 'milyonuse', 'secrets', 32);

export class SecretBox {
  private readonly keys: ReadonlyMap<number, Buffer>;
  readonly current: number;

  constructor(entries: readonly string[]) {
    const keys = new Map<number, Buffer>();
    for (const entry of entries) {
      const [version, encoded] = entry.split(':') as [string, string];
      keys.set(Number(version), Buffer.from(encoded, 'base64'));
    }
    if (keys.size === 0) keys.set(1, Buffer.from(DEVELOPMENT_KEY));
    this.keys = keys;
    this.current = Math.max(...keys.keys());
  }

  seal(plaintext: string, associated: string): Sealed {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.current)!, iv);
    cipher.setAAD(Buffer.from(associated, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { keyVersion: this.current, iv, tag: cipher.getAuthTag(), ciphertext };
  }

  open(sealed: Sealed, associated: string): string {
    const key = this.keys.get(sealed.keyVersion);
    if (!key) throw new Error(`No key ${sealed.keyVersion} to open this secret with`);
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv);
    decipher.setAAD(Buffer.from(associated, 'utf8'));
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  }

  /** A key for signing, derived from the current one and a purpose — never the encryption key itself. */
  signingKey(purpose: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.keys.get(this.current)!, 'milyonuse', `sign:${purpose}`, 32));
  }

  sign(purpose: string, message: string): string {
    return createHmac('sha256', this.signingKey(purpose)).update(message).digest('base64url');
  }
}

const boxes = new WeakMap<Env, SecretBox>();

export function secretBoxFor(env: Env): SecretBox {
  let box = boxes.get(env);
  if (!box) {
    box = new SecretBox(env.SECRETS_KEYS);
    boxes.set(env, box);
  }
  return box;
}
