import type { Metadata } from 'next';
import Link from 'next/link';
import { requestLocale } from '@/i18n/server';
import { LoginForm } from './login-form';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.auth.login.eyebrow };
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string }> }) {
  const { locale, t } = await requestLocale();
  const { next, reset } = await searchParams;
  const l = t.auth.login;

  return (
    <div className="auth-card">
      <header style={{ marginBottom: 28 }}>
        <p className="eyebrow">{l.eyebrow}</p>
        <h1 className="auth-title">
          {l.titleTop}{' '}
          <span className="accent" style={{ color: 'var(--w-65)' }}>
            {l.titleAccent}
          </span>
        </h1>
        <p className="auth-lead">{l.lead}</p>
      </header>

      <LoginForm locale={locale} next={next ?? null} notice={reset === '1' ? l.passwordReset : null} />

      <p className="auth-foot">
        {l.noAccount}{' '}
        <Link href="/register" className="link-quiet" style={{ fontSize: 13.5, color: 'var(--w-80)' }}>
          {l.createAccount}
        </Link>
      </p>
    </div>
  );
}
