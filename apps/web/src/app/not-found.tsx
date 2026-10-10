import Link from 'next/link';
import { requestLocale } from '@/i18n/server';

export default async function NotFound() {
  const { locale, t } = await requestLocale();
  return (
    <main className="auth-split" style={{ display: 'grid', placeItems: 'center', minHeight: '100svh' }}>
      <div className="auth-card" style={{ textAlign: 'center' }}>
        <p className="eyebrow">404</p>
        <h1 className="auth-title">{t.errors.notFoundTitle}</h1>
        <p className="auth-lead">{t.errors.notFoundBody}</p>
        <Link href={`/${locale}`} className="pill pill-primary" style={{ marginTop: 20 }}>
          {t.errors.notFoundAction}
        </Link>
      </div>
    </main>
  );
}
