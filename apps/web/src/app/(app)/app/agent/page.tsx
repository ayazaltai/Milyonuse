import type { Metadata } from 'next';
import type { AgentConversationSummary, AgentConversationView, AgentStatus } from '@milyonuse/contracts';
import { Notice, PageHead } from '@/components/ui/primitives';
import { requestLocale } from '@/i18n/server';
import { apiOrNull } from '@/lib/api';
import { AgentConsole } from './agent-console';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.app.agent.title };
}

/**
 * The agent: what it can do here — whether it is set up, which models, today's
 * allowance — and the person's conversations are read on the server; the
 * conversation itself is the client's. The stage greets the reader itself, so
 * there is no page heading above it.
 */
export default async function AgentPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const { c } = await searchParams;
  const { locale, t } = await requestLocale();
  const [status, conversations] = await Promise.all([
    apiOrNull<AgentStatus>('/agent'),
    apiOrNull<{ items: AgentConversationSummary[] }>('/agent/conversations'),
  ]);

  if (!status || !conversations) {
    return (
      <>
        <PageHead eyebrow={t.app.agent.title} title={t.app.agent.name} accent={t.app.agent.nameAccent} />
        <Notice tone="review">{t.app.agent.unavailableLead}</Notice>
      </>
    );
  }

  const selected =
    c && conversations.items.some((x) => x.id === c)
      ? await apiOrNull<AgentConversationView>(`/agent/conversations/${c}`)
      : null;

  return <AgentConsole locale={locale} status={status} conversations={conversations.items} initial={selected} />;
}
