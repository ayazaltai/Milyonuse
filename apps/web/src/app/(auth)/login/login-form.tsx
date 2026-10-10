'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowRight, Mail } from 'lucide-react';
import type { Locale } from '@milyonuse/contracts';
import { Button, Field, Notice } from '@/components/ui/primitives';
import { getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';
import { arrive } from '../after-sign-in';
import { PasswordInput } from '../password-input';

export function LoginForm({ locale, next, notice }: { locale: Locale; next: string | null; notice: string | null }) {
  const t = getDictionary(locale);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    if (!result.ok) {
      setBusy(false);
      setError(messageFor(result.error, t));
      return;
    }
    await arrive(next);
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
      {notice && <Notice tone="pass">{notice}</Notice>}
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

      <Field label={t.auth.password}>
        <PasswordInput
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          labels={{ show: t.auth.showPassword, hide: t.auth.hidePassword }}
        />
      </Field>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -6 }}>
        <Link href="/forgot" className="link-quiet" style={{ fontSize: 13 }}>
          {t.auth.login.forgot}
        </Link>
      </div>

      <Button
        type="submit"
        variant="primary"
        className="pill-block"
        disabled={busy || email.length === 0 || password.length === 0}
        aria-busy={busy}
      >
        {busy ? (
          <>
            <span className="spinner" aria-hidden="true" />
            {t.auth.login.submitting}
          </>
        ) : (
          <>
            {t.auth.login.submit}
            <ArrowRight size={16} strokeWidth={1.9} />
          </>
        )}
      </Button>
    </form>
  );
}
