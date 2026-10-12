/**
 * TeamBench, draft (F5 §4.4): ten pieces of team work across the three ways
 * of working. Each names its team, its goal, and a reference plan — what a
 * good lead would plan — with one finding per task that the delivered result
 * must carry. A deterministic run follows the reference plan and checks the
 * engine; a live run lets the lead plan for itself and is scored by the same
 * structural checks (score.ts). Quality grading by a model comes with F10.
 */

export type BenchMode = 'hierarchical' | 'pipeline' | 'debate';

export interface BenchTask {
  key: string;
  title: string;
  goal: string;
  assignee: string;
  dependsOn?: string[];
  /** A finding the member's output carries, and the result must too. */
  finding: string;
}

export interface BenchCase {
  id: string;
  goal: string;
  mode: BenchMode;
  team: { lead: string; members: string[]; reviewer?: string };
  /** The reference plan: for hierarchical cases what the lead plans; for the others, what the roster yields. */
  plan: BenchTask[];
  /** Members whose turns fail — the run must route around them. */
  failing?: string[];
  budgetTokens: number;
}

export const TEAM_BENCH: readonly BenchCase[] = [
  {
    id: 'competitor-scan',
    goal: 'What changed at our three main competitors this week?',
    mode: 'hierarchical',
    team: { lead: 'Lena', members: ['Mira', 'Omar', 'Pia'] },
    plan: [
      { key: 't1', title: 'Prices', goal: 'Find price changes', assignee: 'Mira', finding: 'price cut' },
      { key: 't2', title: 'Launches', goal: 'Find product launches', assignee: 'Omar', finding: 'new launch' },
      { key: 't3', title: 'Hires', goal: 'Find senior hires', assignee: 'Pia', finding: 'new CTO' },
    ],
    budgetTokens: 200_000,
  },
  {
    id: 'market-sizing',
    goal: 'Estimate the market for meal kits in Istanbul.',
    mode: 'hierarchical',
    team: { lead: 'Lena', members: ['Deniz', 'Mert'] },
    plan: [
      { key: 't1', title: 'Households', goal: 'Count target households', assignee: 'Mert', finding: 'households' },
      { key: 't2', title: 'Spend', goal: 'Estimate spend per household', assignee: 'Deniz', finding: 'monthly spend' },
      { key: 't3', title: 'Size', goal: 'Multiply into a market size', assignee: 'Deniz', dependsOn: ['t1', 't2'], finding: 'market size' },
    ],
    budgetTokens: 200_000,
  },
  {
    id: 'launch-post',
    goal: 'A launch post for our new scheduling feature.',
    mode: 'pipeline',
    team: { lead: 'Sena', members: ['Yaz'], reviewer: 'Ozan' },
    plan: [
      { key: 's1', title: 'Sena: stage 1', goal: 'Angle and audience', assignee: 'Sena', finding: 'angle' },
      { key: 's2', title: 'Yaz: stage 2', goal: 'The draft', assignee: 'Yaz', dependsOn: ['s1'], finding: 'draft' },
    ],
    budgetTokens: 200_000,
  },
  {
    id: 'pricing-debate',
    goal: 'Should we raise prices by 10% next quarter?',
    mode: 'debate',
    team: { lead: 'Lena', members: ['Pro', 'Con'] },
    plan: [
      { key: 'v1', title: "Pro's answer", goal: 'Should we raise prices by 10% next quarter?', assignee: 'Pro', finding: 'margin' },
      { key: 'v2', title: "Con's answer", goal: 'Should we raise prices by 10% next quarter?', assignee: 'Con', finding: 'churn' },
    ],
    budgetTokens: 200_000,
  },
  {
    id: 'trip-plan',
    goal: 'Plan three days in Lisbon for a team offsite.',
    mode: 'hierarchical',
    team: { lead: 'Ece', members: ['Kaan'], reviewer: 'Rhea' },
    plan: [
      { key: 't1', title: 'Venues', goal: 'Find a venue', assignee: 'Kaan', finding: 'venue' },
      { key: 't2', title: 'Schedule', goal: 'Draft the days', assignee: 'Kaan', dependsOn: ['t1'], finding: 'schedule' },
    ],
    budgetTokens: 200_000,
  },
  {
    id: 'hiring-brief',
    goal: 'A brief for hiring our first data engineer.',
    mode: 'hierarchical',
    team: { lead: 'Lena', members: ['Mira', 'Omar'], reviewer: 'Rhea' },
    plan: [
      { key: 't1', title: 'Role', goal: 'Define the role', assignee: 'Mira', finding: 'responsibilities' },
      { key: 't2', title: 'Pay', goal: 'Benchmark pay', assignee: 'Omar', finding: 'salary band' },
    ],
    budgetTokens: 200_000,
  },
  {
    id: 'literature-review',
    goal: 'What does research say about four-day work weeks?',
    mode: 'hierarchical',
    team: { lead: 'Ada', members: ['Mira', 'Omar', 'Pia'] },
    plan: [
      { key: 't1', title: 'Productivity', goal: 'Productivity studies', assignee: 'Mira', finding: 'productivity' },
      { key: 't2', title: 'Wellbeing', goal: 'Wellbeing studies', assignee: 'Omar', finding: 'wellbeing' },
      { key: 't3', title: 'Costs', goal: 'Cost studies', assignee: 'Pia', finding: 'costs' },
      { key: 't4', title: 'Gaps', goal: 'What is not known', assignee: 'Mira', dependsOn: ['t1', 't2', 't3'], finding: 'open questions' },
    ],
    budgetTokens: 300_000,
  },
  {
    id: 'weekly-digest',
    goal: 'This week’s digest for the leadership team.',
    mode: 'pipeline',
    team: { lead: 'Mert', members: ['Elif'] },
    plan: [
      { key: 's1', title: 'Mert: stage 1', goal: 'What changed', assignee: 'Mert', finding: 'changes' },
      { key: 's2', title: 'Elif: stage 2', goal: 'The digest', assignee: 'Elif', dependsOn: ['s1'], finding: 'digest' },
    ],
    budgetTokens: 200_000,
  },
  {
    id: 'vendor-choice',
    goal: 'Which of three CRM vendors should we choose?',
    mode: 'debate',
    team: { lead: 'Lena', members: ['North', 'South', 'East'] },
    plan: [
      { key: 'v1', title: "North's answer", goal: 'Which of three CRM vendors should we choose?', assignee: 'North', finding: 'integration' },
      { key: 'v2', title: "South's answer", goal: 'Which of three CRM vendors should we choose?', assignee: 'South', finding: 'price' },
      { key: 'v3', title: "East's answer", goal: 'Which of three CRM vendors should we choose?', assignee: 'East', finding: 'support' },
    ],
    budgetTokens: 200_000,
  },
  {
    id: 'resilience',
    goal: 'Summarise our customer interviews from last month.',
    mode: 'hierarchical',
    team: { lead: 'Lena', members: ['Flaky', 'Steady'] },
    plan: [
      { key: 't1', title: 'Themes', goal: 'Find the themes', assignee: 'Flaky', finding: 'themes' },
      { key: 't2', title: 'Quotes', goal: 'Pick telling quotes', assignee: 'Steady', finding: 'quotes' },
    ],
    failing: ['Flaky'],
    budgetTokens: 200_000,
  },
];
