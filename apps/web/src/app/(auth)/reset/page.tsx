import type { Metadata } from 'next';
import Link from 'next/link';
import { Notice } from '@/components/ui/primitives';
import { requestLocale } from '@/i18n/server';
import { ResetForm } from './reset-form';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.auth.reset.eyebrow, robots: { index: false } };
}

export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { locale, t } = await requestLocale();
  const { token } = await searchParams;
  const r = t.auth.reset;
  return (
    <div className="auth-card">
      <header style={{ marginBottom: 24 }}>
        <p className="eyebrow">{r.eyebrow}</p>
        <h1 className="auth-title">
          {r.titleTop}{' '}
          <span className="accent" style={{ color: 'var(--w-65)' }}>
            {r.titleAccent}
          </span>
        </h1>
        <p className="auth-lead">{r.lead}</p>
      </header>
      {token ? (
        <ResetForm locale={locale} token={token} />
      ) : (
        <div className="flex flex-col gap-4">
          <Notice tone="danger">{r.missing}</Notice>
          <Link href="/forgot" className="pill pill-secondary pill-block">
            {r.requestNew}
          </Link>
        </div>
      )}
    </div>
  );
}
