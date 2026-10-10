import type { Metadata } from 'next';
import type { SessionSummary } from '@milyonuse/contracts';
import { PageHead } from '@/components/ui/primitives';
import { requestLocale } from '@/i18n/server';
import { api } from '@/lib/api';
import { PasswordForm } from './password-form';
import { SessionList } from './session-list';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.app.settings.securityTab };
}

export default async function SecurityPage() {
  const { locale, t } = await requestLocale();
  const { items } = await api<{ items: SessionSummary[] }>('/me/sessions');
  const s = t.app.settings.security;

  return (
    <>
      <PageHead eyebrow={t.app.settings.eyebrow} title={s.titleTop} accent={s.titleAccent} lead={s.lead} />
      <div className="flex flex-col gap-6">
        <PasswordForm locale={locale} />
        <SessionList locale={locale} sessions={items} />
      </div>
    </>
  );
}
