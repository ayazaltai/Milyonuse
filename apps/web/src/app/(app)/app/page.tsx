import type { Metadata } from 'next';
import type { Me } from '@milyonuse/contracts';
import { PageHead, Panel, Tag } from '@/components/ui/primitives';
import { requestLocale } from '@/i18n/server';
import { api } from '@/lib/api';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.app.nav.home };
}

export default async function HomePage() {
  const { t } = await requestLocale();
  const me = await api<Me>('/auth/session');
  const h = t.app.home;
  const firstName = me.user.name.split(' ')[0] ?? me.user.name;

  return (
    <>
      <PageHead eyebrow={h.eyebrow} title={h.titleTop(firstName)} accent={h.titleAccent} lead={h.lead} />
      <Panel title={h.roadmapTitle}>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 }}>
          {h.roadmap.map((item, index) => (
            <li key={item.title} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <Tag tone="brand">F{index + 1}</Tag>
              <span>
                <span style={{ display: 'block', fontSize: 14.5, color: 'var(--w-95)' }}>{item.title}</span>
                <span style={{ display: 'block', fontSize: 13, color: 'var(--w-50)', marginTop: 4 }}>{item.text}</span>
              </span>
            </li>
          ))}
        </ol>
      </Panel>
    </>
  );
}
