import type { Metadata } from 'next';
import type { AutomationView, InboxView, StudioAgentView, TeamView } from '@milyonuse/contracts';
import { Notice, PageHead } from '@/components/ui/primitives';
import { requestLocale } from '@/i18n/server';
import { apiOrNull } from '@/lib/api';
import { InboxBoard } from './inbox-board';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.app.inbox.title };
}

/** The Inbox (F6 §3): everything waiting for the person's word, in one place. */
export default async function InboxPage() {
  const { locale, t } = await requestLocale();
  const k = t.app.inbox;
  const [inbox, agents, teams, automations] = await Promise.all([
    apiOrNull<InboxView>('/inbox'),
    apiOrNull<{ items: StudioAgentView[] }>('/agents'),
    apiOrNull<{ items: TeamView[] }>('/teams'),
    apiOrNull<{ items: AutomationView[] }>('/automations'),
  ]);
  if (!inbox) {
    return (
      <>
        <PageHead eyebrow={k.eyebrow} title={k.titleTop} accent={k.titleAccent} />
        <Notice tone="review">{t.app.teams.unavailable}</Notice>
      </>
    );
  }
  return <InboxBoard locale={locale} initial={inbox} agents={agents?.items ?? []} teams={teams?.items ?? []} automations={automations?.items ?? []} />;
}
