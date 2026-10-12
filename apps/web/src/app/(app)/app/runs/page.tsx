import type { Metadata } from 'next';
import type { AutomationView, RunStatus, RunSummaryView, StudioAgentView, TeamView } from '@milyonuse/contracts';
import { Notice, PageHead } from '@/components/ui/primitives';
import { requestLocale } from '@/i18n/server';
import { apiOrNull } from '@/lib/api';
import { RunList } from './run-list';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.app.runList.title };
}

const STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'];

/** Every run (F6 §4): a team's, an agent's alone, an automation's — filtered by state. */
export default async function RunsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const chosen = STATUSES.find((s) => s === status) ?? null;
  const { locale, t } = await requestLocale();
  const k = t.app.runList;
  const [runs, teams, agents, automations] = await Promise.all([
    apiOrNull<{ items: RunSummaryView[] }>(`/runs${chosen ? `?status=${chosen}` : ''}`),
    apiOrNull<{ items: TeamView[] }>('/teams?archived=true'),
    apiOrNull<{ items: StudioAgentView[] }>('/agents'),
    apiOrNull<{ items: AutomationView[] }>('/automations'),
  ]);
  if (!runs) {
    return (
      <>
        <PageHead eyebrow={k.eyebrow} title={k.titleTop} accent={k.titleAccent} />
        <Notice tone="review">{t.app.teams.unavailable}</Notice>
      </>
    );
  }
  return (
    <RunList
      locale={locale}
      runs={runs.items}
      status={chosen}
      statuses={STATUSES}
      names={{
        teams: Object.fromEntries((teams?.items ?? []).map((x) => [x.id, x.name])),
        agents: Object.fromEntries((agents?.items ?? []).map((x) => [x.id, `${x.avatar} ${x.name}`])),
        automations: Object.fromEntries((automations?.items ?? []).map((x) => [x.id, x.name])),
      }}
    />
  );
}
