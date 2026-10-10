import type { Metadata } from 'next';
import { requestLocale } from '@/i18n/server';
import { VerifyEmail } from './verify-email';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.auth.verify.eyebrow, robots: { index: false } };
}

/**
 * The page a registration's link opens. The token is spent by a POST from the
 * page, never by the GET that opened it: a mail scanner that follows every
 * link must not open an account nobody asked for.
 */
export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { locale, t } = await requestLocale();
  const { token } = await searchParams;
  const v = t.auth.verify;

  return (
    <div className="auth-card">
      <header style={{ marginBottom: 24 }}>
        <p className="eyebrow">{v.eyebrow}</p>
        <h1 className="auth-title">
          {v.titleTop}{' '}
          <span className="accent" style={{ color: 'var(--w-65)' }}>
            {v.titleAccent}
          </span>
        </h1>
      </header>
      <VerifyEmail locale={locale} token={token ?? null} />
    </div>
  );
}
