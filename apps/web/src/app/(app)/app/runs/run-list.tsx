'use client';

import Link from 'next/link';
import type { Locale, RunStatus, RunSummaryView } from '@milyonuse/contracts';
import { CellPair, Empty, PageHead, Panel, Table, Tag, Td, Th } from '@/components/ui/primitives';
import { getDictionary } from '@/i18n';
import { runTone } from '../teams/[teamId]/team-detail';

/** The runs, newest first, with who did each and what it cost. Filtering is a link, so the page stays a server page. */
export function RunList({
  locale,
  runs,
  status,
  statuses,
  names,
}: {
  locale: Locale;
  runs: RunSummaryView[];
  status: RunStatus | null;
  statuses: readonly RunStatus[];
  names: { teams: Record<string, string>; agents: Record<string, string>; automations: Record<string, string> };
}) {
  const t = getDictionary(locale);
  const k = t.app.runList;
  const r = t.app.runs;
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  const who = (run: RunSummaryView) => {
    const doer = run.teamId ? `${k.team}: ${names.teams[run.teamId] ?? '—'}` : `${k.agent}: ${run.agentId ? (names.agents[run.agentId] ?? '—') : '—'}`;
    const by = run.automationId ? `${k.automation}: ${names.automations[run.automationId] ?? '—'}` : undefined;
    return <CellPair title={doer} sub={by} />;
  };

  return (
    <>
      <PageHead eyebrow={k.eyebrow} title={k.titleTop} accent={k.titleAccent} lead={k.lead} />
      <nav className="filter-pills" aria-label={k.status}>
        <Link className={`pill pill-sm ${status === null ? 'pill-primary' : 'pill-ghost'}`} href="/app/runs" aria-current={status === null ? 'page' : undefined}>
          {k.all}
        </Link>
        {statuses.map((s) => (
          <Link key={s} className={`pill pill-sm ${status === s ? 'pill-primary' : 'pill-ghost'}`} href={`/app/runs?status=${s}`} aria-current={status === s ? 'page' : undefined}>
            {r.statuses[s]}
          </Link>
        ))}
      </nav>
      <Panel flush>
        {runs.length === 0 ? (
          <Empty title={k.none} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{k.goal}</Th>
                <Th>{k.who}</Th>
                <Th>{k.status}</Th>
                <Th num>{k.spent}</Th>
                <Th>{k.started}</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <Td>
                    <Link href={`/app/runs/${run.id}`} className="cell-title">
                      {run.goal.length > 90 ? `${run.goal.slice(0, 90)}…` : run.goal}
                    </Link>
                  </Td>
                  <Td>{who(run)}</Td>
                  <Td>
                    <Tag tone={runTone(run.status)}>{r.statuses[run.status]}</Tag>
                  </Td>
                  <Td num>
                    {number.format(run.spentTokens)} / {number.format(run.budgetTokens)}
                  </Td>
                  <Td nowrap muted>
                    {date.format(new Date(run.createdAt))}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </>
  );
}
