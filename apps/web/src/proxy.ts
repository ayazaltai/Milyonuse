import { type NextRequest, NextResponse } from 'next/server';
import { LOCALES, isLocale } from '@milyonuse/contracts';
import { LOCALE_COOKIE, LOCALE_HEADER, resolveLocale } from './i18n';

/**
 * In front of every page (Next 16's `proxy`, formerly `middleware`):
 *
 *   language   English unless the person chose another (D-17): `/` goes to
 *              `/en`, or to the language they picked; every other page is
 *              told its language through a request header, read by the root
 *              layout, and a `?lang=` carried from a page in one language is
 *              kept
 *   the app    `/app…` needs a session cookie, or it goes to sign-in and comes
 *              back afterwards. The cookie is only a hint here — the API
 *              decides — but it spares an anonymous visitor a flash of shell
 *   headers    one strict policy: this site loads nothing from anywhere else
 */

const SESSION_COOKIE = 'mu_session';
const MARKETING = new RegExp(`^/(${LOCALES.join('|')})(/|$)`);

function contentSecurityPolicy(https: boolean): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    // Next.js inlines its bootstrap; it needs eval in development only.
    `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    // The fonts are self-hosted by next/font and served from this origin.
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "media-src 'none'",
    // Only where the site is served over TLS: on http://127.0.0.1 it would
    // send every asset to an https:// that is not there.
    https ? 'upgrade-insecure-requests' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function secure(response: NextResponse, https: boolean): NextResponse {
  response.headers.set('content-security-policy', contentSecurityPolicy(https));
  response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('x-frame-options', 'DENY');
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  response.headers.set('cross-origin-opener-policy', 'same-origin');
  if (https) response.headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');
  return response;
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search, searchParams } = request.nextUrl;
  const https = request.nextUrl.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
  // A link from a page in one language to a page without one (`/register?lang=tr`)
  // carries the language along, and it is remembered from then on.
  const carried = searchParams.get('lang');
  const chosen = isLocale(carried)
    ? carried
    : resolveLocale(request.cookies.get(LOCALE_COOKIE)?.value);

  if (pathname === '/') {
    return secure(NextResponse.redirect(new URL(`/${chosen}`, request.url)), https);
  }

  if ((pathname === '/app' || pathname.startsWith('/app/')) && !request.cookies.has(SESSION_COOKIE)) {
    const login = new URL('/login', request.url);
    login.searchParams.set('next', `${pathname}${search}`);
    return secure(NextResponse.redirect(login), https);
  }

  const inPath = MARKETING.exec(pathname)?.[1];
  const headers = new Headers(request.headers);
  headers.set(LOCALE_HEADER, inPath ?? chosen);
  const response = secure(NextResponse.next({ request: { headers } }), https);
  if (isLocale(carried)) {
    response.cookies.set(LOCALE_COOKIE, carried, { path: '/', maxAge: 31_536_000, sameSite: 'lax' });
  }
  return response;
}

export const config = {
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico|icon.png|brand/|robots.txt|sitemap.xml).*)'],
};
