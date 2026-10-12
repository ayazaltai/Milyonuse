import type { RunTaskView, TeamMemberView } from '@milyonuse/contracts';

const W = 196;
const H = 56;
const GAP_X = 56;
const GAP_Y = 16;

/** Each task in the column after the deepest task it depends on. */
export function layout(tasks: readonly RunTaskView[]): Map<string, { x: number; y: number }> {
  const level = new Map<string, number>();
  for (const t of tasks) level.set(t.key, t.dependsOn.length === 0 ? 0 : 1 + Math.max(...t.dependsOn.map((d) => level.get(d) ?? 0)));
  const rows = new Map<number, number>();
  const at = new Map<string, { x: number; y: number }>();
  for (const t of tasks) {
    const col = level.get(t.key) ?? 0;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    at.set(t.key, { x: col * (W + GAP_X), y: row * (H + GAP_Y) });
  }
  return at;
}

/** The task graph: a box per task with its member, status and key; an edge per dependency. */
export function RunGraph({ tasks, members, labels }: { tasks: RunTaskView[]; members: TeamMemberView[]; labels: Record<RunTaskView['status'], string> }) {
  const at = layout(tasks);
  const width = Math.max(...[...at.values()].map((p) => p.x)) + W + 2;
  const height = Math.max(...[...at.values()].map((p) => p.y)) + H + 2;
  const who = new Map(members.map((m) => [m.agentId, m]));
  return (
    <div className="run-graph">
      <svg width={width} height={height} viewBox={`-1 -1 ${width} ${height}`} role="img" aria-label="Task graph">
        {tasks.flatMap((t) =>
          t.dependsOn.map((d) => {
            const from = at.get(d);
            const to = at.get(t.key);
            if (!from || !to) return null;
            const x1 = from.x + W;
            const y1 = from.y + H / 2;
            const x2 = to.x;
            const y2 = to.y + H / 2;
            return <path key={`${d}-${t.key}`} className="run-edge" d={`M${x1},${y1} C${x1 + GAP_X / 2},${y1} ${x2 - GAP_X / 2},${y2} ${x2},${y2}`} />;
          }),
        )}
        {tasks.map((t) => {
          const p = at.get(t.key)!;
          const member = t.assignedAgentId ? who.get(t.assignedAgentId) : undefined;
          return (
            <g key={t.id} className="run-node" data-status={t.status} transform={`translate(${p.x},${p.y})`}>
              <title>{`${t.key}: ${t.title} — ${labels[t.status]}`}</title>
              <rect width={W} height={H} rx={12} />
              <text className="run-node-avatar" x={12} y={33}>
                {member?.avatar ?? '·'}
              </text>
              <text x={38} y={24}>
                {t.title.length > 22 ? `${t.title.slice(0, 21)}…` : t.title}
              </text>
              <text className="run-node-key" x={38} y={42}>
                {`${t.key} · ${labels[t.status]}${member ? ` · ${member.name}` : ''}`.slice(0, 32)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
