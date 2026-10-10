'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Mail, MailCheck } from 'lucide-react';
import type { Locale } from '@milyonuse/contracts';
import { Button, Field, Notice } from '@/components/ui/primitives';
import { getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';
import { DevelopmentLink } from '../password-input';

/** The same answer for every address: whether it has an account is said in the mail, to its owner. */
export function ForgotForm({ locale }: { locale: Locale }) {
  const t = getDictionary(locale);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ developmentLink?: string } | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await request<{ developmentLink?: string }>('/auth/password/forgot', {
      method: 'POST',
      body: JSON.stringify({ email }),
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
            {t.auth.forgot.sentTitle}
          </span>
        </Notice>
        <p className="auth-lead" style={{ margin: 0 }}>
          {t.auth.forgot.sentBody}
        </p>
        <DevelopmentLink href={sent.developmentLink} text={t.auth.developmentLink} action={t.auth.developmentLinkAction} />
        <Link href="/login" className="link-quiet" style={{ fontSize: 13.5 }}>
          {t.auth.forgot.backToLogin}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
      {error && <Notice tone="danger">{error}</Notice>}
      <Field label={t.auth.email}>
        <span className="control-wrap">
          <Mail size={16} strokeWidth={1.7} />
          <input
            type="email"
            name="email"
            required
            autoFocus
            autoComplete="email"
            inputMode="email"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t.auth.emailPlaceholder}
            className="control control-lg"
          />
        </span>
      </Field>
      <Button type="submit" variant="primary" className="pill-block" disabled={busy || email.length === 0} aria-busy={busy}>
        {busy ? (
          <>
            <span className="spinner" aria-hidden="true" />
            {t.auth.forgot.submitting}
          </>
        ) : (
          t.auth.forgot.submit
        )}
      </Button>
      <Link href="/login" className="link-quiet" style={{ fontSize: 13.5, textAlign: 'center' }}>
        {t.auth.forgot.backToLogin}
      </Link>
    </form>
  );
}
