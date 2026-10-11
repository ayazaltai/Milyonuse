/**
 * Credential redaction (ported from Agent 5.5 `security/redact.py`, Apache-2.0).
 *
 * Text that flows back into the model — tool results, connection errors, a
 * page's body — is scrubbed of what looks like a secret, so a key leaked into
 * an error string can be neither learned nor echoed. And the environment a
 * sandboxed process starts with is cut down to what is plainly not a secret.
 */

const PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{20,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bgho_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}/g, // Google OAuth access token
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/]+:[^@\s]+@/gi, // a password in a connection string
];

export const REDACTED = '[REDACTED]';

export function redact(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match) => {
      // Keep a connection string's scheme, so what it was is still readable.
      const scheme = /^([a-z+]+):\/\//i.exec(match);
      return scheme && match.includes('@') ? `${scheme[1]}://${REDACTED}@` : REDACTED;
    });
  }
  return out;
}

/** Every string inside a value, redacted — the shape kept. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  }
  return value;
}

const ENV_ALLOWLIST = new Set(['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'TMPDIR', 'TZ']);
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE/i;

/**
 * An environment cut down to the allow-list, XDG_* and what the caller names
 * — and never anything named like a secret unless the caller names it exactly.
 */
export function safeEnv(base: Record<string, string | undefined>, extraAllow: readonly string[] = []): Record<string, string> {
  const allow = new Set([...ENV_ALLOWLIST, ...extraAllow]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (SECRET_NAME.test(key) && !extraAllow.includes(key)) continue;
    if (allow.has(key) || key.startsWith('XDG_')) out[key] = value;
  }
  return out;
}
