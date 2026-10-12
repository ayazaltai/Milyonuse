import type { Metadata } from 'next';
import type { StudioAgentView, TeamTemplateView, TeamView } from '@milyonuse/contracts';
import { Notice, PageHead } from '@/components/ui/primitives';
import { requestLocale } from '@/i18n/server';
import { apiOrNull } from '@/lib/api';
import { TeamsGallery } from './teams-gallery';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.app.teams.title };
}

/** Teams (F5 §3): the person's teams, the templates, and their agents to build a team from. */
export default async function TeamsPage() {
  const { locale, t } = await requestLocale();
  const k = t.app.teams;
  const [teams, templates, agents] = await Promise.all([
    apiOrNull<{ items: TeamView[] }>('/teams?archived=true'),
    apiOrNull<{ items: TeamTemplateView[] }>(`/teams/templates?locale=${locale === 'tr' ? 'tr' : 'en'}`),
    apiOrNull<{ items: StudioAgentView[] }>('/agents'),
  ]);
  if (!teams || !templates || !agents) {
    return (
      <>
        <PageHead eyebrow={k.eyebrow} title={k.titleTop} accent={k.titleAccent} />
        <Notice tone="review">{k.unavailable}</Notice>
      </>
    );
  }
  return <TeamsGallery locale={locale} initial={teams.items} templates={templates.items} agents={agents.items} />;
}
