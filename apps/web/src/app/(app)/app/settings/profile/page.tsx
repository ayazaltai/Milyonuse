import type { Metadata } from 'next';
import type { Me } from '@milyonuse/contracts';
import { PageHead } from '@/components/ui/primitives';
import { requestLocale } from '@/i18n/server';
import { api } from '@/lib/api';
import { ProfileForm } from './profile-form';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.app.settings.profileTab };
}

export default async function ProfilePage() {
  const { locale, t } = await requestLocale();
  const me = await api<Me>('/me');
  const p = t.app.settings.profile;
  // The zones Node knows, for the picker; the database checks the one chosen.
  const zones = Intl.supportedValuesOf('timeZone');

  return (
    <>
      <PageHead eyebrow={t.app.settings.eyebrow} title={p.titleTop} accent={p.titleAccent} lead={p.lead} />
      <ProfileForm locale={locale} me={me} zones={zones} />
    </>
  );
}
