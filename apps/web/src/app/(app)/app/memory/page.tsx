import type { Metadata } from 'next';
import type { MemoryLedgerStatus, MemoryListView } from '@milyonuse/contracts';
import { Notice, PageHead } from '@/components/ui/primitives';
import { requestLocale } from '@/i18n/server';
import { apiOrNull } from '@/lib/api';
import { MemoryInspector } from './memory-inspector';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.app.memory.title };
}

/**
 * The Memory page (F2 §4): what the agent remembers about the person, how much
 * each memory is trusted now, why it is known, and what the person decides.
 * What is kept and the ledger's integrity are read on the server; filtering,
 * the "why" and every decision are the client's.
 */
export default async function MemoryPage() {
  const { locale, t } = await requestLocale();
  const m = t.app.memory;
  const [list, ledger] = await Promise.all([
    apiOrNull<MemoryListView>('/memory?state=active'),
    apiOrNull<MemoryLedgerStatus>('/memory/ledger'),
  ]);

  if (!list || !ledger) {
    return (
      <>
        <PageHead eyebrow={m.eyebrow} title={m.titleTop} accent={m.titleAccent} />
        <Notice tone="review">{m.unavailable}</Notice>
      </>
    );
  }

  return <MemoryInspector locale={locale} initial={list} ledger={ledger} />;
}
