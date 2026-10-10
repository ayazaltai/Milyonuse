import type { Metadata } from 'next';
import Link from 'next/link';
import { requestLocale } from '@/i18n/server';
import { RegisterForm } from './register-form';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.auth.register.eyebrow };
}

/**
 * Registering: a name, an address, a password. Nothing is created until the
 * address is confirmed — following the mailed link opens the account, its
 * personal workspace and a session together.
 */
export default async function RegisterPage() {
  const { locale, t } = await requestLocale();
  const r = t.auth.register;

  return (
    <div className="auth-card auth-card-wide">
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

      <RegisterForm locale={locale} />

      <p className="auth-foot">
        {r.haveAccount}{' '}
        <Link href="/login" className="link-quiet" style={{ fontSize: 13.5, color: 'var(--w-80)' }}>
          {t.common.signIn}
        </Link>
      </p>
    </div>
  );
}
