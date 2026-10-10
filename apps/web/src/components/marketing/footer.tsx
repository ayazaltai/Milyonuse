import Link from 'next/link';
import type { Locale } from '@milyonuse/contracts';
import { Lockup } from '@/components/brand/lockup';
import type { Dictionary } from '@/i18n';
import { LanguageSwitch } from './language-switch';

export function Footer({ locale, t }: { locale: Locale; t: Dictionary }) {
  const f = t.marketing.footer;
  const home = `/${locale}`;

  return (
    <footer className="mk-footer">
      <div className="mk-inner">
        <div className="mk-footer-top">
          <div>
            <Lockup size={30} byline={t.common.byline} />
            <p className="mk-footer-tagline">{f.tagline}</p>
          </div>
          <div>
            <p className="mk-footer-heading">{f.product}</p>
            <ul className="mk-footer-links">
              <li>
                <a href={`${home}#how`}>{t.nav.how}</a>
              </li>
              <li>
                <a href={`${home}#capabilities`}>{t.nav.capabilities}</a>
              </li>
              <li>
                <Link href={`${home}/pricing`}>{t.nav.pricing}</Link>
              </li>
              <li>
                <a href={`${home}#faq`}>{t.nav.faq}</a>
              </li>
            </ul>
          </div>
          <div>
            <p className="mk-footer-heading">{f.company}</p>
            <ul className="mk-footer-links">
              <li>
                <a href="https://www.milyonus.com" rel="noopener">
                  {f.about}
                </a>
              </li>
              <li>
                <Link href={`/login?lang=${locale}`}>{t.common.signIn}</Link>
              </li>
              <li>
                <Link href={`/register?lang=${locale}`}>{t.common.signUp}</Link>
              </li>
            </ul>
          </div>
          <div>
            <p className="mk-footer-heading">{f.legal}</p>
            <ul className="mk-footer-links">
              <li>
                <Link href={`${home}/privacy`}>{f.privacy}</Link>
              </li>
              <li>
                <Link href={`${home}/terms`}>{f.terms}</Link>
              </li>
              <li>
                <Link href={`${home}/cookies`}>{f.cookies}</Link>
              </li>
            </ul>
          </div>
        </div>

        <p className="mk-footer-wordmark mk-serif" aria-hidden="true">
          Milyonuse
        </p>

        <div className="mk-footer-bottom">
          <span>
            &copy; {new Date().getFullYear()} {f.rights}
          </span>
          <LanguageSwitch current={locale} label={t.common.language} />
        </div>
      </div>
    </footer>
  );
}
