import { redirect } from 'next/navigation';
import type { Me } from '@milyonuse/contracts';
import { Sidebar } from '@/components/shell/sidebar';
import { requestLocale } from '@/i18n/server';
import { apiOrNull } from '@/lib/api';

/**
 * The signed-in shell: fixed sidebar, content column. Who is signed in is
 * asked once, server-side, and handed down; a stale cookie lands on sign-in.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await apiOrNull<Me>('/auth/session');
  if (!me) redirect('/login?next=/app');
  const { locale } = await requestLocale();

  return (
    <div className="shell">
      <Sidebar me={me} locale={locale} />
      <div className="content">
        <div className="page-max">{children}</div>
      </div>
    </div>
  );
}
