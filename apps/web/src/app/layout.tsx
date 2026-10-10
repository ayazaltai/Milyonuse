import type { Metadata, Viewport } from 'next';
import { Instrument_Serif, Inter_Tight, Montserrat } from 'next/font/google';
import { ground } from '@milyonuse/ui';
import { requestLocale } from '@/i18n/server';
import './globals.css';

/**
 * Three faces, two surfaces (DECISIONS D-07). The app runs on Montserrat and
 * builds its two-line headings from weight and slant; the marketing pages pair
 * Inter Tight with Instrument Serif. All self-hosted by next/font: no request
 * to a third party, and a size-adjusted fallback so nothing shifts when the
 * real face arrives.
 */
const montserrat = Montserrat({
  subsets: ['latin', 'latin-ext'],
  weight: ['300', '400', '500', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--font-montserrat',
  display: 'swap',
});

const interTight = Inter_Tight({
  subsets: ['latin', 'latin-ext'],
  weight: ['300', '400', '500', '600'],
  variable: '--font-inter-tight',
  display: 'swap',
});

const instrumentSerif = Instrument_Serif({
  subsets: ['latin', 'latin-ext'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-instrument-serif',
  display: 'swap',
});

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return {
    title: { default: t.meta.title, template: `%s · ${t.common.product}` },
    description: t.meta.description,
    metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://127.0.0.1:3000'),
  };
}

export const viewport: Viewport = {
  // Pure black: the browser chrome should not be a lighter shade than the page it frames.
  themeColor: ground.ink,
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale } = await requestLocale();
  return (
    <html lang={locale} className={`${montserrat.variable} ${interTight.variable} ${instrumentSerif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
