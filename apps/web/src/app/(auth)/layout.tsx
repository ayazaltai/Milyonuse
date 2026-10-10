import Image from 'next/image';
import Link from 'next/link';
import { Bot, ShieldCheck, Workflow } from 'lucide-react';
import { Lockup } from '@/components/brand/lockup';
import { LanguageSwitch } from '@/components/marketing/language-switch';
import { requestLocale } from '@/i18n/server';

const POINT_ICONS = [Bot, Workflow, ShieldCheck];

/**
 * The shell for the pages a signed-out visitor can reach: sign in, create an
 * account, confirm an address, set a new password.
 *
 * Two columns on a wide screen — the lit brand panel says what this is, the
 * form does the one thing the page is for. Below 960px the panel goes and the
 * lockup moves above the form.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const { locale, t } = await requestLocale();

  return (
    <div className="auth-split">
      <aside className="auth-brand">
        {/* Lazy, not priority: on a phone the panel is hidden and the rays are never fetched. */}
        <Image src="/brand/light-rays.png" alt="" fill sizes="55vw" className="auth-brand-rays" />
        <div className="auth-brand-inner">
          <Link href={`/${locale}`} style={{ textDecoration: 'none' }}>
            <Lockup size={36} byline={t.common.byline} />
          </Link>

          <div>
            <p className="eyebrow">{t.auth.brandEyebrow}</p>
            <h2 className="auth-brand-title">
              {t.auth.brandTitleTop}{' '}
              <span className="accent" style={{ color: 'var(--w-65)' }}>
                {t.auth.brandTitleAccent}
              </span>
            </h2>
            <ul className="auth-points">
              {t.auth.brandPoints.map((point, index) => {
                const Icon = POINT_ICONS[index] ?? ShieldCheck;
                return (
                  <li key={point.title}>
                    <span className="auth-point-icon">
                      <Icon size={17} strokeWidth={1.7} />
                    </span>
                    <span>
                      <span className="auth-point-title">{point.title}</span>
                      <span className="auth-point-text">{point.text}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          <p className="auth-brand-foot">milyonuse.com</p>
        </div>
      </aside>

      <main className="auth-main">
        <div className="auth-main-logo">
          <Link href={`/${locale}`} style={{ textDecoration: 'none' }}>
            <Lockup size={32} />
          </Link>
        </div>
        {children}
        <footer className="auth-legal">
          <span>&copy; {new Date().getFullYear()} Milyonus Inc.</span>
          <span className="legal-links">
            <Link href={`/${locale}/privacy`}>{t.marketing.footer.privacy}</Link>
            <Link href={`/${locale}/terms`}>{t.marketing.footer.terms}</Link>
          </span>
          <LanguageSwitch current={locale} label={t.common.language} />
        </footer>
      </main>
    </div>
  );
}
