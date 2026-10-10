import { headers } from 'next/headers';
import { DEFAULT_LOCALE, type Locale, isLocale } from '@milyonuse/contracts';
import { type Dictionary, LOCALE_HEADER, getDictionary } from './index';

/** The language the proxy resolved for this request, and its dictionary. */
export async function requestLocale(): Promise<{ locale: Locale; t: Dictionary }> {
  const value = (await headers()).get(LOCALE_HEADER);
  const locale = isLocale(value) ? value : DEFAULT_LOCALE;
  return { locale, t: getDictionary(locale) };
}
