'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowRight, Mail, MailCheck, UserRound } from 'lucide-react';
import { type Locale, PASSWORD_POLICY } from '@milyonuse/contracts';
import { Button, Checkbox, Field, Notice } from '@/components/ui/primitives';
import { getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';
import { DevelopmentLink, PasswordInput } from '../password-input';

interface Registered {
  status: 'verification_sent';
  developmentLink?: string;
}

/**
 * The answer here is always "check your inbox", whoever the address belongs
 * to; what actually happened is in the mail, for the address's owner to read.
 * The browser's time zone goes along, so schedules run in the person's own
 * hours from the first day.
 */
export function RegisterForm({ locale }: { locale: Locale }) {
  const t = getDictionary(locale);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Registered | null>(null);

  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const result = await request<Registered>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ ...form, locale, timeZone, acceptTerms }),
    });
    setBusy(false);
    if (!result.ok) {
      setError(messageFor(result.error, t));
      return;
    }
    setSent(result.data);
  }

  if (sent) {
    return (
      <div className="flex flex-col gap-4">
        <Notice tone="pass">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <MailCheck size={16} strokeWidth={1.8} />
            {t.auth.register.sentTitle(form.email)}
          </span>
        </Notice>
        <p className="auth-lead" style={{ margin: 0 }}>
          {t.auth.register.sentBody}
        </p>
        <p className="auth-lead" style={{ margin: 0, fontSize: 13 }}>
          {t.auth.register.sentHelp}
        </p>
        <DevelopmentLink href={sent.developmentLink} text={t.auth.developmentLink} action={t.auth.developmentLinkAction} />
      </div>
    );
  }

  const ready =
    form.name.trim().length > 0 &&
    form.email.length > 0 &&
    form.password.length >= PASSWORD_POLICY.minLength &&
    acceptTerms;

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
      {error && <Notice tone="danger">{error}</Notice>}

      <Field label={t.auth.name}>
        <span className="control-wrap">
          <UserRound size={16} strokeWidth={1.7} />
          <input
            name="name"
            required
            autoFocus
            autoComplete="name"
            value={form.name}
            onChange={(e) => set('name')(e.target.value)}
            placeholder={t.auth.namePlaceholder}
            className="control control-lg"
          />
        </span>
      </Field>

      <Field label={t.auth.email}>
        <span className="control-wrap">
          <Mail size={16} strokeWidth={1.7} />
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            inputMode="email"
            spellCheck={false}
            value={form.email}
            onChange={(e) => set('email')(e.target.value)}
            placeholder={t.auth.emailPlaceholder}
            className="control control-lg"
          />
        </span>
      </Field>

      <Field label={t.auth.password} hint={t.auth.passwordHint(PASSWORD_POLICY.minLength)}>
        <PasswordInput
          value={form.password}
          onChange={set('password')}
          autoComplete="new-password"
          labels={{ show: t.auth.showPassword, hide: t.auth.hidePassword }}
        />
      </Field>

      <Checkbox
        checked={acceptTerms}
        onChange={setAcceptTerms}
        label={
          <>
            {t.auth.acceptTermsBefore}{' '}
            <Link href={`/${locale}/terms`} target="_blank" className="link-quiet">
              {t.auth.acceptTermsTerms}
            </Link>{' '}
            {t.auth.acceptTermsAnd}{' '}
            <Link href={`/${locale}/privacy`} target="_blank" className="link-quiet">
              {t.auth.acceptTermsPrivacy}
            </Link>
            {t.auth.acceptTermsAfter}
          </>
        }
      />

      <Button type="submit" variant="primary" className="pill-block" disabled={busy || !ready} aria-busy={busy}>
        {busy ? (
          <>
            <span className="spinner" aria-hidden="true" />
            {t.auth.register.submitting}
          </>
        ) : (
          <>
            {t.auth.register.submit}
            <ArrowRight size={16} strokeWidth={1.9} />
          </>
        )}
      </Button>
    </form>
  );
}
