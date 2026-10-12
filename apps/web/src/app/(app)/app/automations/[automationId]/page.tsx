import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { AutomationDetailView, AutomationView, StudioAgentView, TeamView } from '@milyonuse/contracts';
import { requestLocale } from '@/i18n/server';
import { apiOrNull } from '@/lib/api';
import { AutomationDetail } from './automation-detail';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.app.automations.title };
}

/** One automation: what starts it, what it started, and the person's controls. */
export default async function AutomationPage({ params }: { params: Promise<{ automationId: string }> }) {
  const { automationId } = await params;
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(automationId)) notFound();
  const { locale } = await requestLocale();
  const [automation, all, agents, teams] = await Promise.all([
    apiOrNull<AutomationDetailView>(`/automations/${automationId}`),
    apiOrNull<{ items: AutomationView[] }>('/automations'),
    apiOrNull<{ items: StudioAgentView[] }>('/agents'),
    apiOrNull<{ items: TeamView[] }>('/teams'),
  ]);
  if (!automation) notFound();
  return <AutomationDetail locale={locale} initial={automation} automations={all?.items ?? []} agents={agents?.items ?? []} teams={teams?.items ?? []} />;
}
