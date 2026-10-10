import { SettingsTabs } from './settings-tabs';
import { requestLocale } from '@/i18n/server';

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { t } = await requestLocale();
  return (
    <>
      <SettingsTabs
        tabs={[
          { href: '/app/settings/profile', label: t.app.settings.profileTab },
          { href: '/app/settings/security', label: t.app.settings.securityTab },
        ]}
      />
      {children}
    </>
  );
}
