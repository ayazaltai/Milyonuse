'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LOCALES, type Locale } from '@milyonuse/contracts';

/**
 * The two languages, side by side. A page whose address names its language
 * links to the same page in the other one; any other page stays where it is
 * and carries the choice as `?lang=`, which the proxy remembers.
 */
export function LanguageSwitch({ current, label }: { current: Locale; label: string }) {
  const path = usePathname();
  const hrefFor = (locale: Locale): string =>
    /^\/(en|tr)(\/|$)/.test(path) ? path.replace(/^\/(en|tr)/, `/${locale}`) : `${path}?lang=${locale}`;

  return (
    <nav className="mk-lang" aria-label={label}>
      {LOCALES.map((locale) => (
        <Link
          key={locale}
          href={hrefFor(locale)}
          hrefLang={locale}
          aria-current={locale === current ? 'true' : undefined}
          // A page without its language in the address must be fetched again, not reused.
          prefetch={false}
        >
          {locale.toUpperCase()}
        </Link>
      ))}
    </nav>
  );
}
