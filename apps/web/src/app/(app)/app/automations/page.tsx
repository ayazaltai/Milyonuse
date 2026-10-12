import type { Metadata } from 'next';
import type { AutomationView, StudioAgentView, TeamView } from '@milyonuse/contracts';
import { Notice, PageHead } from '@/components/ui/primitives';
import { requestLocale } from '@/i18n/server';
import { apiOrNull } from '@/lib/api';
import { AutomationsList } from './automations-list';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.app.automations.title };
}

/** Automations (F6 §4): the person's automations, and the agents and teams they can run. */
export default async function AutomationsPage() {
  const { locale, t } = await requestLocale();
  const k = t.app.automations;
  const [automations, agents, teams] = await Promise.all([
    apiOrNull<{ items: AutomationView[] }>('/automations'),
    apiOrNull<{ items: StudioAgentView[] }>('/agents'),
    apiOrNull<{ items: TeamView[] }>('/teams'),
  ]);
  if (!automations || !agents || !teams) {
    return (
      <>
        <PageHead eyebrow={k.eyebrow} title={k.titleTop} accent={k.titleAccent} />
        <Notice tone="review">{t.app.teams.unavailable}</Notice>
      </>
    );
  }
  return <AutomationsList locale={locale} initial={automations.items} agents={agents.items} teams={teams.items} />;
}
