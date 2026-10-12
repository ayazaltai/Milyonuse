import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * What every adapter shares: constant-time comparison, commands, pairing
 * codes (ported from Agent 5.5 `gateway/pairing.py`) and the data a button
 * carries.
 */

/** No 0/O/1/I/L: a code is read off one screen and typed into another. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 8;

export function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** A code as it is stored: a digest, so a database read never yields one that works. */
export function codeDigest(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

/** A code somewhere in what a person sent — on its own, or after `/pair` or `/start`. */
export function codeIn(text: string): string | null {
  const re = new RegExp(`(?:^|[^A-Za-z0-9])([${CODE_ALPHABET}]{${CODE_LENGTH}})(?![A-Za-z0-9])`);
  return re.exec(text.trim().toUpperCase())?.[1] ?? null;
}

/** `/report this week` (a Telegram `/report@MilyonuseBot` too) as a command; anything else is not one. */
export function commandOf(text: string): { name: string; args: string } | null {
  const m = /^\/([A-Za-z][A-Za-z0-9_]{0,31})(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1]!.toLowerCase(), args: (m[2] ?? '').trim() } : null;
}

/** Constant-time over digests, so neither content nor length leaks. */
export function same(given: string, expected: string): boolean {
  const d = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(d(given), d(expected));
}

export function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

/** Text cut into pieces a channel takes, on a line break where there is one. */
export function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  let rest = text.length > 0 ? text : ' ';
  while (rest.length > size) {
    const cut = rest.lastIndexOf('\n', size);
    const at = cut > size / 2 ? cut : size;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  out.push(rest);
  return out;
}

// ───────────────────────────────────────────────────── what a button carries

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export type ActionVerb = 'confirm' | 'discard';

/** `a:c:<id>` — short enough for Telegram's 64-byte callback data. */
export function encodeAction(verb: ActionVerb, id: string): string {
  return `a:${verb === 'confirm' ? 'c' : 'd'}:${id}`;
}

export function decodeAction(data: string): { verb: ActionVerb; id: string } | null {
  const m = /^a:([cd]):(\S+)$/.exec(data);
  if (!m || !ULID.test(m[2]!)) return null;
  return { verb: m[1] === 'c' ? 'confirm' : 'discard', id: m[2]! };
}

/** A header read case-insensitively, as every channel's documentation spells it differently. */
export function header(headers: Record<string, string | undefined>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return value;
  return undefined;
}

export const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const asString = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
