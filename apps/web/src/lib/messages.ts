import type { Dictionary } from '@/i18n';
import type { ClientError } from './client-api';

/**
 * The sentence to show for a refusal: ours, in the reader's language, for the
 * codes a form can meet; otherwise the API's own sentence, which names the
 * field; otherwise a generic one.
 */
export function messageFor(error: ClientError, t: Dictionary): string {
  const known = (t.errors as Record<string, unknown>)[error.code];
  if (typeof known === 'string' && error.code !== 'validation_failed') return known;
  return error.message || t.errors.generic;
}
