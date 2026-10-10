// Error messages quote recipients and values whatever the call site intended, so masking is the logger's job, not each caller's.

const MASK = '[redacted]';
const MAX_DEPTH = 8;

/** Normalised field names (lower case, letters and digits only) whose value is dropped whole. */
const SENSITIVE_FIELDS: ReadonlySet<string> = new Set([
  'to',
  'cc',
  'bcc',
  'recipient',
  'recipients',
  'name',
  'firstname',
  'lastname',
  'fullname',
  'phone',
  'authorization',
  'cookie',
  'setcookie',
  'password',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'credentials',
  'likenessname',
]);

const SENSITIVE_SUFFIXES = ['email', 'token', 'secret', 'password', 'phone', 'apikey'] as const;

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
// Written narrowly on purpose: timestamps, ids and counts fill error messages,
// and a pattern loose enough to catch every phone number masks those too.
const PHONE_INTERNATIONAL = /\+\d[\d\s().-]{6,}\d/g;
const PHONE_NATIONAL = /(?:\(\d{3}\)\s?|\b\d{3}[-.\s])\d{3}[-.\s]\d{4}\b/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const SECRET_PREFIXED = /\b(?:sk|pk|rk|whsec|sess)_[A-Za-z0-9_-]{12,}\b|\bsk-[A-Za-z0-9_-]{16,}\b/g;
const SIGNED_PARAM =
  /([?&](?:token|code|key|secret|signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&\s"']+/gi;

function normalise(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveField(field: string): boolean {
  const key = normalise(field);
  return SENSITIVE_FIELDS.has(key) || SENSITIVE_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

export function scrub(text: string): string {
  return text
    .replace(SIGNED_PARAM, `$1${MASK}`)
    .replace(BEARER, `$1 ${MASK}`)
    .replace(JWT, '[token]')
    .replace(SECRET_PREFIXED, '[secret]')
    .replace(EMAIL, '[email]')
    .replace(PHONE_INTERNATIONAL, '[phone]')
    .replace(PHONE_NATIONAL, '[phone]');
}

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrub(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (value instanceof Date) return value;
  if (value instanceof Error) {
    return { name: value.name, message: scrub(value.message), ...(value.stack ? { stack: scrub(value.stack) } : {}) };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [field, inner] of Object.entries(value)) {
    out[field] = isSensitiveField(field) && inner !== null && inner !== undefined ? MASK : redact(inner, depth + 1);
  }
  return out;
}
