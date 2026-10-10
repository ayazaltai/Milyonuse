'use client';

import { useState } from 'react';
import { type Locale, PASSWORD_POLICY } from '@milyonuse/contracts';
import { PasswordInput } from '@/app/(auth)/password-input';
import { Button, Field, Notice, Panel } from '@/components/ui/primitives';
import { getDictionary } from '@/i18n';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';

export function PasswordForm({ locale }: { locale: Locale }) {
  const t = getDictionary(locale);
  const s = t.app.settings.security;
  const labels = { show: t.auth.showPassword, hide: t.auth.hidePassword };
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'pass' | 'danger'; text: string } | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const result = await request('/me/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    setBusy(false);
    if (!result.ok) {
      setMessage({ tone: 'danger', text: messageFor(result.error, t) });
      return;
    }
    setCurrent('');
    setNew('');
    setMessage({ tone: 'pass', text: s.passwordChanged });
  }

  return (
    <Panel title={s.passwordTitle}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" style={{ maxWidth: 520 }}>
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
        <Field label={s.currentPassword}>
          <PasswordInput
            name="current-password"
            value={currentPassword}
            onChange={setCurrent}
            autoComplete="current-password"
            labels={labels}
          />
        </Field>
        <Field label={s.newPassword} hint={t.auth.passwordHint(PASSWORD_POLICY.minLength)}>
          <PasswordInput name="new-password" value={newPassword} onChange={setNew} autoComplete="new-password" labels={labels} />
        </Field>
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || currentPassword.length === 0 || newPassword.length < PASSWORD_POLICY.minLength}
            aria-busy={busy}
          >
            {s.changePassword}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
