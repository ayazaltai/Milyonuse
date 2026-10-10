import { DEFAULT_LOCALE, type Locale, isLocale } from '@milyonuse/contracts';
import { type Dictionary, en } from './dictionaries/en';
import { tr } from './dictionaries/tr';

export type { Dictionary, Locale };

const dictionaries: Record<Locale, Dictionary> = { en, tr };

export function getDictionary(locale: Locale = DEFAULT_LOCALE): Dictionary {
  return dictionaries[locale];
}

/** The cookie that remembers a language someone chose (strictly necessary; see the cookie policy). */
export const LOCALE_COOKIE = 'mu_locale';

/** The request header the proxy hands the resolved language to server components in. */
export const LOCALE_HEADER = 'x-mu-locale';

/**
 * The language for a request with no language in its path: one chosen
 * before (the cookie), else the browser's first preference we ship, else
 * English.
 */
export function resolveLocale(cookie: string | undefined, acceptLanguage: string | null): Locale {
  if (isLocale(cookie)) return cookie;
  for (const part of (acceptLanguage ?? '').split(',')) {
    const tag = part.split(';')[0]?.trim().toLowerCase().slice(0, 2);
    if (isLocale(tag)) return tag;
  }
  return DEFAULT_LOCALE;
}
