import type { Metadata } from 'next';
import type { ConnectionAppView, ConnectionView } from '@milyonuse/contracts';
import { Notice, PageHead } from '@/components/ui/primitives';
import { requestLocale } from '@/i18n/server';
import { apiOrNull } from '@/lib/api';
import { ConnectionsBoard } from './connections-board';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.app.connections.title };
}

/**
 * Connections (F3 §3): the apps a person connected, and the ones they can.
 * Connecting leaves for the app's consent page and comes back here with
 * `?connected=` or `?error=`.
 */
export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const { connected, error } = await searchParams;
  const { locale, t } = await requestLocale();
  const c = t.app.connections;
  const [apps, connections] = await Promise.all([
    apiOrNull<{ items: ConnectionAppView[] }>('/connections/apps'),
    apiOrNull<{ items: ConnectionView[] }>('/connections'),
  ]);
  if (!apps || !connections) {
    return (
      <>
        <PageHead eyebrow={c.eyebrow} title={c.titleTop} accent={c.titleAccent} />
        <Notice tone="review">{c.unavailable}</Notice>
      </>
    );
  }
  return (
    <ConnectionsBoard
      locale={locale}
      apps={apps.items}
      initial={connections.items}
      notice={connected ? { tone: 'pass', text: c.justConnected } : error ? { tone: 'danger', text: error.slice(0, 300) } : null}
    />
  );
}
