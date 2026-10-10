'use client';

import type { Locale } from '@milyonuse/contracts';
import { LOCALE_COOKIE } from './index';

/** Remembers a language for a year. Strictly necessary: it is the person's own choice. */
export function rememberLocale(locale: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
}
