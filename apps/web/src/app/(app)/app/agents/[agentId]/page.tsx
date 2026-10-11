import type { Metadata } from 'next';
import type { SkillSummaryView, StudioAgentVersionView, StudioAgentView, StudioToolOption } from '@milyonuse/contracts';
import { notFound } from 'next/navigation';
import { Notice, PageHead } from '@/components/ui/primitives';
import { requestLocale } from '@/i18n/server';
import { apiOrNull } from '@/lib/api';
import { AgentEditor } from './agent-editor';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.app.studio.title };
}

/** One agent: who it is, what its current version says, its history, and a chat to try it in. */
export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ agentId: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const { agentId } = await params;
  const { created } = await searchParams;
  const { locale, t } = await requestLocale();
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(agentId)) notFound();
  const [agent, versions, tools, skills] = await Promise.all([
    apiOrNull<StudioAgentView>(`/agents/${agentId}`),
    apiOrNull<{ items: StudioAgentVersionView[] }>(`/agents/${agentId}/versions`),
    apiOrNull<{ items: StudioToolOption[] }>('/agents/tools'),
    apiOrNull<{ items: SkillSummaryView[] }>('/skills'),
  ]);
  if (!agent || !versions) notFound();
  if (!tools || !skills) {
    return (
      <>
        <PageHead eyebrow={t.app.studio.eyebrow} title={agent.name} accent={agent.roleTitle} />
        <Notice tone="review">{t.app.studio.unavailable}</Notice>
      </>
    );
  }
  return (
    <AgentEditor
      locale={locale}
      initial={agent}
      initialVersions={versions.items}
      tools={tools.items}
      skills={skills.items}
      justCreated={created === '1'}
    />
  );
}
