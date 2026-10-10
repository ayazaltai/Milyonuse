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
 * The language for a request with no language in its path: one the person
 * chose (the cookie), else English. The browser's preferences are never read:
 * English is the default everywhere until someone picks another language
 * (DECISIONS D-17).
 */
export function resolveLocale(cookie: string | undefined): Locale {
  return isLocale(cookie) ? cookie : DEFAULT_LOCALE;
}
