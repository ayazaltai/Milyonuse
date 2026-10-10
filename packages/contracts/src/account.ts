import { z } from 'zod';
import { LOCALES, PASSWORD_POLICY } from './constants.js';
import { ulidSchema } from './primitives.js';

/**
 * Accounts: registering, confirming the address, signing in with a password,
 * setting one, and the person's own profile.
 *
 * An address is compared without regard to case everywhere it is stored
 * (citext), and normalised here so that what is mailed, counted by the rate
 * limit and written is the same string.
 */

export const accountEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address.')
  .max(254);

export const newPasswordSchema = z
  .string()
  .min(PASSWORD_POLICY.minLength, `Use at least ${PASSWORD_POLICY.minLength} characters.`)
  .max(PASSWORD_POLICY.maxLength, `Use at most ${PASSWORD_POLICY.maxLength} characters.`);

export const localeSchema = z.enum(LOCALES);

/**
 * An IANA time zone name, as the browser reports it. Whether Postgres knows it
 * is the database's call (app.assert_time_zone, HINT time_zone_unknown).
 */
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_+\-/]+$/, 'Choose a time zone from the list.');

/** A link's token, as it arrives from the page the mail opened. */
const accountTokenSchema = z.string().min(20).max(200);

export const registerInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(120),
  email: accountEmailSchema,
  password: newPasswordSchema,
  locale: localeSchema.default('en'),
  timeZone: timeZoneSchema.default('UTC'),
  acceptTerms: z.literal(true, 'Accept the Terms of Service and the Privacy Policy to continue.'),
});
export type RegisterInput = z.infer<typeof registerInputSchema>;

export const verifyEmailInputSchema = z.object({ token: accountTokenSchema });

export const passwordSignInInputSchema = z.object({
  email: accountEmailSchema,
  // Whatever was typed: a sign-in checks a password, it does not judge one.
  password: z.string().min(1, 'Enter your password.').max(PASSWORD_POLICY.maxLength),
});
export type PasswordSignInInput = z.infer<typeof passwordSignInInputSchema>;

export const forgotPasswordInputSchema = z.object({ email: accountEmailSchema });

export const resetPasswordInputSchema = z.object({
  token: accountTokenSchema,
  password: newPasswordSchema,
});

export const changePasswordInputSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.').max(PASSWORD_POLICY.maxLength),
  newPassword: newPasswordSchema,
});

/** The person's own profile. Every field optional: send what changed. */
export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter your name.').max(120),
    locale: localeSchema,
    timeZone: timeZoneSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');
export type UpdateProfile = z.infer<typeof updateProfileSchema>;

/** What `GET /me` and `GET /auth/session` answer. */
export const meSchema = z.object({
  user: z.object({
    id: ulidSchema,
    email: z.string(),
    name: z.string(),
    locale: localeSchema,
    timeZone: z.string(),
    createdAt: z.string(),
  }),
  organization: z.object({
    id: ulidSchema,
    name: z.string(),
    kind: z.enum(['personal', 'shared']),
  }),
  member: z.object({
    id: ulidSchema,
    role: z.enum(['owner', 'admin', 'member']),
  }),
});
export type Me = z.infer<typeof meSchema>;

export const sessionSummarySchema = z.object({
  id: ulidSchema,
  current: z.boolean(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
