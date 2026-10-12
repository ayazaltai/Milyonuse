import type { Metadata } from 'next';
import type { RunView } from '@milyonuse/contracts';
import { notFound } from 'next/navigation';
import { requestLocale } from '@/i18n/server';
import { apiOrNull } from '@/lib/api';
import { RunViewer } from './run-viewer';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestLocale();
  return { title: t.app.runs.title };
}

/** A team run: its graph as it moves, what happened, the result, and the person's word on it. */
export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(runId)) notFound();
  const { locale } = await requestLocale();
  const run = await apiOrNull<RunView>(`/runs/${runId}`);
  if (!run) notFound();
  return <RunViewer locale={locale} initial={run} />;
}
