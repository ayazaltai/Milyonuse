import type { MetadataRoute } from 'next';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://127.0.0.1:3000';

/** The public pages are for search engines; the app and the account pages are not. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: ['/en', '/tr'], disallow: ['/app', '/api', '/verify', '/reset'] },
    sitemap: `${SITE}/sitemap.xml`,
  };
}
