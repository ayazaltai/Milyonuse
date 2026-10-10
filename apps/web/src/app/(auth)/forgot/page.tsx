import type { Metadata } from 'next';
import { requestLocale } from '@/i18n/server';
import { ForgotForm } from './forgot-form';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.auth.forgot.eyebrow };
}

export default async function ForgotPage() {
  const { locale, t } = await requestLocale();
  const f = t.auth.forgot;
  return (
    <div className="auth-card">
      <header style={{ marginBottom: 24 }}>
        <p className="eyebrow">{f.eyebrow}</p>
        <h1 className="auth-title">
          {f.titleTop}{' '}
          <span className="accent" style={{ color: 'var(--w-65)' }}>
            {f.titleAccent}
          </span>
        </h1>
        <p className="auth-lead">{f.lead}</p>
      </header>
      <ForgotForm locale={locale} />
    </div>
  );
}
