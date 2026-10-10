import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale } from '@milyonuse/contracts';
import { LegalPage } from '@/components/marketing/legal-page';
import { getDictionary } from '@/i18n';

/** When the text below last changed. */
const UPDATED = '2026-10-10';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return isLocale(locale) ? { title: getDictionary(locale).legal.terms.title } : {};
}

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDictionary(locale);
  return <LegalPage document={t.legal.terms} t={t} updated={UPDATED} />;
}
