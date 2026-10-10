'use client';

import Link from 'next/link';
import { useState } from 'react';
import { type Locale, PASSWORD_POLICY } from '@milyonuse/contracts';
import { Button, Field, Notice } from '@/components/ui/primitives';
import { getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';
import { PasswordInput } from '../password-input';

export function ResetForm({ locale, token }: { locale: Locale; token: string }) {
  const t = getDictionary(locale);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<{ message: string; spent: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await request('/auth/password/reset', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
    if (!result.ok) {
      setBusy(false);
      // A weak password leaves the link usable; an unknown, used or expired one does not.
      setError({ message: messageFor(result.error, t), spent: result.error.code === 'not_found' });
      return;
    }
    window.location.assign('/login?reset=1');
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
      {error && <Notice tone="danger">{error.message}</Notice>}
      {error?.spent ? (
        <Link href="/forgot" className="pill pill-secondary pill-block">
          {t.auth.reset.requestNew}
        </Link>
      ) : (
        <>
          <Field label={t.auth.password} hint={t.auth.passwordHint(PASSWORD_POLICY.minLength)}>
            <PasswordInput
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              autoFocus
              labels={{ show: t.auth.showPassword, hide: t.auth.hidePassword }}
            />
          </Field>
          <Button
            type="submit"
            variant="primary"
            className="pill-block"
            disabled={busy || password.length < PASSWORD_POLICY.minLength}
            aria-busy={busy}
          >
            {busy ? (
              <>
                <span className="spinner" aria-hidden="true" />
                {t.auth.reset.submitting}
              </>
            ) : (
              t.auth.reset.submit
            )}
          </Button>
        </>
      )}
    </form>
  );
}
