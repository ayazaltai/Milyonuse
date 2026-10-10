import type { MetadataRoute } from 'next';
import { LOCALES } from '@milyonuse/contracts';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://127.0.0.1:3000';
const PAGES = ['', '/pricing', '/privacy', '/terms', '/cookies'];

/** Every public page, in every language, each naming its translations. */
export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.flatMap((page) =>
    LOCALES.map((locale) => ({
      url: `${SITE}/${locale}${page}`,
      changeFrequency: 'weekly' as const,
      priority: page === '' ? 1 : 0.5,
      alternates: { languages: Object.fromEntries(LOCALES.map((l) => [l, `${SITE}/${l}${page}`])) },
    })),
  );
}
