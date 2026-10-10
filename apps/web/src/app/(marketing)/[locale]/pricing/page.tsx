import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale } from '@milyonuse/contracts';
import { Plans } from '@/components/marketing/plans';
import { getDictionary } from '@/i18n';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return isLocale(locale) ? { title: getDictionary(locale).nav.pricing } : {};
}

export default async function PricingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const p = getDictionary(locale).marketing.pricing;
  return (
    <section className="mk-section" style={{ paddingTop: 150 }} aria-labelledby="pricing-title">
      <div className="mk-inner">
        <header className="mk-head mk-head-center">
          <p className="mk-eyebrow">{p.eyebrow}</p>
          <h1 id="pricing-title" className="mk-h2">
            <span>{p.titleTop}</span>
            <span className="mk-serif">{p.titleAccent}</span>
          </h1>
        </header>
        <Plans locale={locale} />
      </div>
    </section>
  );
}
