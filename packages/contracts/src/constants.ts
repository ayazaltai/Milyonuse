/**
 * Values the browser uses, defined without a schema library.
 *
 * The schema modules next to this one build on zod, and a page that imports
 * one plain value from them carries every schema in the module — and zod —
 * into its JavaScript. What a client component needs at runtime lives here,
 * and the schemas import it from here.
 */

/** The languages the product ships in. The first is the fallback. */
export const LOCALES = ['en', 'tr'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * What a password must be. Length is the rule that matters and the one a form
 * can say up front; the API also refuses a password that contains the address
 * or is on its list of the most common ones.
 */
export const PASSWORD_POLICY = {
  minLength: 10,
  maxLength: 128,
} as const;

/** What an account mail's link is good for, in hours (0002 keeps them to this). */
export const ACCOUNT_LINK_HOURS = {
  verifyEmail: 24,
  setPassword: 1,
} as const;

/**
 * Session lifetimes (0003 caps the absolute one at 90 days). A consumer
 * product keeps people signed in across a week of not opening it; a session
 * still ends after a month whatever happens.
 */
export const SESSION_POLICY = {
  idleDays: 7,
  absoluteDays: 30,
  /** How recently a password must have been presented before a sensitive change. */
  reauthMinutes: 15,
} as const;

/** The published legal pages, relative to the web origin, per locale. */
export const LEGAL_PATHS = {
  terms: '/terms',
  privacy: '/privacy',
  cookies: '/cookies',
} as const;
