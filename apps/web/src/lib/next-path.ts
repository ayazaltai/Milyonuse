/**
 * Where to go after signing in: a page of this site the person was on their
 * way to, and never anywhere else. Only a same-origin path is accepted: it
 * starts with one slash, not two, and carries no backslash, so
 * "//evil.example" and "/\\evil.example" are refused.
 */
export function safeNext(value: string | null | undefined): string | null {
  if (!value || value.length > 2048) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  try {
    const url = new URL(value, 'https://milyonuse.invalid');
    if (url.origin !== 'https://milyonuse.invalid') return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}
