'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Menu, X } from 'lucide-react';
import type { Locale } from '@milyonuse/contracts';
import { Lockup } from '@/components/brand/lockup';
import { getDictionary } from '@/i18n';

/**
 * The public pages' navigation: the lockup, the sections in a floating pill,
 * sign-in and the call to action. Clear over the hero; frosted once the page
 * scrolls. Below 1024px the sections move into a full-screen menu.
 */
export function Navbar({ locale, signedIn }: { locale: Locale; signedIn: boolean }) {
  // Read here, not handed down: a dictionary carries functions, and a server
  // component cannot pass a function to a client one.
  const t = getDictionary(locale);
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  const home = `/${locale}`;
  const sections = [
    { href: `${home}#how`, label: t.nav.how },
    { href: `${home}#capabilities`, label: t.nav.capabilities },
    { href: `${home}#trust`, label: t.nav.trust },
    { href: `/${locale}/pricing`, label: t.nav.pricing },
    { href: `${home}#faq`, label: t.nav.faq },
  ];
  const cta = signedIn
    ? { href: '/app', label: t.common.openApp }
    : { href: `/register?lang=${locale}`, label: t.common.signUp };

  return (
    <header className="mk-nav" data-scrolled={scrolled ? 'true' : 'false'}>
      <div className="mk-nav-row">
        <Link href={home} aria-label={t.common.product} style={{ textDecoration: 'none' }}>
          <Lockup size={30} />
        </Link>

        <nav className="mk-nav-links" aria-label={t.common.menu}>
          {sections.map((item) => (
            <a key={item.href} href={item.href} className="mk-nav-link">
              {item.label}
            </a>
          ))}
        </nav>

        <div className="mk-nav-actions">
          {!signedIn && (
            <Link href={`/login?lang=${locale}`} className="mk-nav-signin">
              {t.common.signIn}
            </Link>
          )}
          <Link href={cta.href} className="mk-cta">
            {cta.label}
          </Link>
          <button type="button" className="mk-menu-button" aria-label={t.common.menu} onClick={() => setOpen(true)}>
            <Menu size={18} />
          </button>
        </div>
      </div>

      {open && (
        <div className="mk-menu" role="dialog" aria-modal="true" aria-label={t.common.menu}>
          <div className="mk-nav-row">
            <Lockup size={30} />
            <button
              type="button"
              className="mk-menu-button"
              style={{ marginLeft: 'auto' }}
              aria-label={t.common.closeMenu}
              onClick={() => setOpen(false)}
            >
              <X size={18} />
            </button>
          </div>
          <nav className="mk-menu-links">
            {sections.map((item) => (
              <a key={item.href} href={item.href} className="mk-menu-link" onClick={() => setOpen(false)}>
                {item.label}
              </a>
            ))}
            {!signedIn && (
              <Link href={`/login?lang=${locale}`} className="mk-menu-link" onClick={() => setOpen(false)}>
                {t.common.signIn}
              </Link>
            )}
          </nav>
        </div>
      )}
    </header>
  );
}
