import { createHash, createPublicKey, generateKeyPairSync, sign as signWith, verify as verifyWith } from 'node:crypto';

/**
 * Operator signing — the cryptographic boundary of T0 (ported from Agent 5.5
 * `security/operator.py`, on Node's own Ed25519).
 *
 * T0 is operator authority, not a claim, and no text the model sees — a
 * message, a file, a tool's answer — can reach it. A T0 write carries an
 * Ed25519 signature made with a private key that never lives on the API host;
 * the host holds public keys only, so it can verify an operator's claim and
 * can never forge one.
 *
 * Verification fails closed: no key, a malformed key or a malformed signature
 * is a refusal, never an exception that some caller might swallow.
 */

export interface OperatorKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

/** A new operator key pair — for the operator's own machine, never the host's. */
export function generateOperatorKeyPair(): OperatorKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** Signs a message; the signature as base64. */
export function signMessage(privateKeyPem: string, message: string): string {
  return signWith(null, Buffer.from(message, 'utf8'), privateKeyPem).toString('base64');
}

/**
 * Whether `signature` (base64) over `message` was made by the key behind one
 * of `publicKeysPem`. Answers the matching key's fingerprint, or null.
 */
export function verifyOperator(publicKeysPem: readonly string[], message: string, signature: string): string | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return null;
  const bytes = Buffer.from(signature, 'base64');
  if (bytes.length !== 64) return null;
  for (const pem of publicKeysPem) {
    try {
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType !== 'ed25519') continue;
      if (verifyWith(null, Buffer.from(message, 'utf8'), key, bytes)) return fingerprint(pem);
    } catch {
      // A key that cannot be read verifies nothing.
    }
  }
  return null;
}

/** A short, stable name for a public key: sha256 of its DER, first 16 hex. */
export function fingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return `sha256:${createHash('sha256').update(der).digest('hex').slice(0, 16)}`;
}
