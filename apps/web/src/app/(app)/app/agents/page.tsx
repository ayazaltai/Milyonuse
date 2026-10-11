import type { Metadata } from 'next';
import type { StudioAgentView, StudioTemplateView } from '@milyonuse/contracts';
import { Notice, PageHead } from '@/components/ui/primitives';
import { requestLocale } from '@/i18n/server';
import { apiOrNull } from '@/lib/api';
import { StudioGallery } from './studio-gallery';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.app.studio.title };
}

/**
 * The studio (F4 §1): the person's agents, archived ones included for the
 * filter, and the templates in their language.
 */
export default async function AgentsPage() {
  const { locale, t } = await requestLocale();
  const s = t.app.studio;
  const [agents, templates] = await Promise.all([
    apiOrNull<{ items: StudioAgentView[] }>('/agents?archived=true'),
    apiOrNull<{ items: StudioTemplateView[] }>(`/agents/templates?locale=${locale === 'tr' ? 'tr' : 'en'}`),
  ]);
  if (!agents || !templates) {
    return (
      <>
        <PageHead eyebrow={s.eyebrow} title={s.titleTop} accent={s.titleAccent} />
        <Notice tone="review">{s.unavailable}</Notice>
      </>
    );
  }
  return <StudioGallery locale={locale} initial={agents.items} templates={templates.items} />;
}
