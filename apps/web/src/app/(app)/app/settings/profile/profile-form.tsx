'use client';

import { useState } from 'react';
import { LOCALES, type Locale, type Me } from '@milyonuse/contracts';
import { Button, Field, Notice, Panel } from '@/components/ui/primitives';
import { getDictionary } from '@/i18n';
import { rememberLocale } from '@/i18n/client';
import { request } from '@/lib/client-api';
import { messageFor } from '@/lib/messages';

export function ProfileForm({ locale, me, zones }: { locale: Locale; me: Me; zones: string[] }) {
  const t = getDictionary(locale);
  const p = t.app.settings.profile;
  const [form, setForm] = useState({ name: me.user.name, locale: me.user.locale, timeZone: me.user.timeZone });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'pass' | 'danger'; text: string } | null>(null);

  const changed =
    form.name.trim() !== me.user.name || form.locale !== me.user.locale || form.timeZone !== me.user.timeZone;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const change = {
      ...(form.name.trim() !== me.user.name ? { name: form.name.trim() } : {}),
      ...(form.locale !== me.user.locale ? { locale: form.locale } : {}),
      ...(form.timeZone !== me.user.timeZone ? { timeZone: form.timeZone } : {}),
    };
    const result = await request<Me>('/me', { method: 'PATCH', body: JSON.stringify(change) });
    setBusy(false);
    if (!result.ok) {
      setMessage({ tone: 'danger', text: messageFor(result.error, t) });
      return;
    }
    if (change.locale) {
      // The pages follow the account's language: render them again in it.
      rememberLocale(change.locale);
      window.location.reload();
      return;
    }
    setMessage({ tone: 'pass', text: t.common.saved });
  }

  return (
    <Panel>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" style={{ maxWidth: 520 }}>
        {message && <Notice tone={message.tone}>{message.text}</Notice>}

        <Field label={p.name}>
          <input
            name="name"
            required
            autoComplete="name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="control"
          />
        </Field>

        <Field label={p.email} hint={p.emailHint}>
          <input value={me.user.email} readOnly disabled className="control" />
        </Field>

        <Field label={p.locale}>
          <select
            value={form.locale}
            onChange={(e) => setForm({ ...form, locale: e.target.value as Locale })}
            className="control"
          >
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {t.common.languages[l]}
              </option>
            ))}
          </select>
        </Field>

        <Field label={p.timeZone} hint={p.timeZoneHint}>
          <select value={form.timeZone} onChange={(e) => setForm({ ...form, timeZone: e.target.value })} className="control">
            {(zones.includes(form.timeZone) ? zones : [form.timeZone, ...zones]).map((zone) => (
              <option key={zone} value={zone}>
                {zone.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </Field>

        <div>
          <Button type="submit" variant="primary" disabled={busy || !changed || form.name.trim().length === 0} aria-busy={busy}>
            {busy ? t.common.saving : t.common.save}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
