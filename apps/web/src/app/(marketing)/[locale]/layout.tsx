import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { LOCALES, isLocale } from '@milyonuse/contracts';
import { Footer } from '@/components/marketing/footer';
import { Navbar } from '@/components/marketing/navbar';
import { getDictionary } from '@/i18n';

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = getDictionary(locale);
  return {
    title: { absolute: t.meta.title },
    description: t.meta.description,
    alternates: { languages: Object.fromEntries(LOCALES.map((l) => [l, `/${l}`])) },
    openGraph: { title: t.meta.title, description: t.meta.description, locale, type: 'website' },
  };
}

/**
 * The public pages: navigation, the page, the footer. The language is in the
 * address (`/en`, `/tr`), so every page has one canonical URL per language.
 */
export default async function MarketingLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDictionary(locale);
  // A hint for the call to action only; the app itself asks the API.
  const signedIn = (await cookies()).has('mu_session');

  return (
    <div className="mk">
      <a href="#main" className="mk-skip">
        {t.common.skipToContent}
      </a>
      <Navbar locale={locale} signedIn={signedIn} />
      <main id="main">{children}</main>
      <Footer locale={locale} t={t} />
    </div>
  );
}
