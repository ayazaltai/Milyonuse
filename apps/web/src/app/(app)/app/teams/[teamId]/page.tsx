import type { Metadata } from 'next';
import type { RunSummaryView, StudioAgentView, TeamView } from '@milyonuse/contracts';
import { notFound } from 'next/navigation';
import { requestLocale } from '@/i18n/server';
import { apiOrNull } from '@/lib/api';
import { TeamDetail } from './team-detail';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.app.teams.title };
}

/** One team: who is on it, its runs, and a goal to give it. */
export default async function TeamPage({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(teamId)) notFound();
  const { locale } = await requestLocale();
  const [team, runs, agents] = await Promise.all([
    apiOrNull<TeamView>(`/teams/${teamId}`),
    apiOrNull<{ items: RunSummaryView[] }>(`/teams/${teamId}/runs`),
    apiOrNull<{ items: StudioAgentView[] }>('/agents'),
  ]);
  if (!team || !runs) notFound();
  return <TeamDetail locale={locale} initial={team} runs={runs.items} agents={agents?.items ?? []} />;
}
