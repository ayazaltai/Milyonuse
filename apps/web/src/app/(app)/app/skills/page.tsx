import type { Metadata } from 'next';
import type { SkillCatalogueEntry, SkillSummaryView } from '@milyonuse/contracts';
import { Notice, PageHead } from '@/components/ui/primitives';
import { requestLocale } from '@/i18n/server';
import { apiOrNull } from '@/lib/api';
import { SkillsBoard } from './skills-board';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.app.skills.title };
}

/** Skills (F4 §2): the person's library, what waits for their word, and the catalogue. */
export default async function SkillsPage() {
  const { locale, t } = await requestLocale();
  const k = t.app.skills;
  const [skills, catalogue] = await Promise.all([
    apiOrNull<{ items: SkillSummaryView[] }>('/skills'),
    apiOrNull<{ items: SkillCatalogueEntry[] }>('/skills/catalogue'),
  ]);
  if (!skills || !catalogue) {
    return (
      <>
        <PageHead eyebrow={k.eyebrow} title={k.titleTop} accent={k.titleAccent} />
        <Notice tone="review">{k.unavailable}</Notice>
      </>
    );
  }
  return <SkillsBoard locale={locale} initial={skills.items} catalogue={catalogue.items} />;
}
