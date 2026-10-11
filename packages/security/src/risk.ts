import { type PreExecFinding, scanCommand } from './preexec.js';

/**
 * The RiskEngine (ported from Agent 5.5 `security/risk.py`, Apache-2.0, as the
 * matrix of D-11).
 *
 * Every tool call is classified before it runs:
 *
 *   auto      run now
 *   proposal  prepare it as a proposal a person confirms
 *   block     never run, in any mode
 *
 *   mode / context          safe   caution+reversible   caution+irreversible   danger
 *   ask                     auto   proposal             proposal               proposal
 *   auto                    auto   auto                 proposal               proposal
 *   plan                    auto   block                block                  block
 *   unattended (safe_only)  auto   proposal             proposal               proposal
 *   unattended (trusted)    auto   auto                 proposal               proposal
 *
 * A tool declares its own risk; what it does can only make that worse: a name
 * that sends, deletes or pays is irreversible whatever a connection declared,
 * and code is scanned before it runs. No grant, mode or setting turns the
 * irreversible class into `auto`.
 */

export type ToolRisk = 'safe' | 'caution' | 'danger';
export type RiskDecision = 'auto' | 'proposal' | 'block';
export type RunMode = 'ask' | 'auto' | 'plan';

export interface RiskTool {
  name: string;
  risk: ToolRisk;
  reversible: boolean;
}

export interface RiskInput {
  tool: RiskTool;
  args: Record<string, unknown>;
  mode: RunMode;
  /** Nobody is watching (an automation, F6): the organization's policy decides what reversible work may run. */
  unattended?: { policy: 'safe_only' | 'trusted' } | undefined;
}

export interface RiskVerdict {
  decision: RiskDecision;
  reason: string;
  /** The risk the call is treated as, after what it does was read. */
  risk: ToolRisk;
  reversible: boolean;
  findings: PreExecFinding[];
}

/** Words in a tool's name that mean the world changes in a way nobody can take back. */
// Verbs only, matched as whole words: `list_messages` reads, `send_message` sends.
const IRREVERSIBLE = [
  'send', 'reply', 'forward', 'post', 'publish', 'tweet', 'invite',
  'delete', 'remove', 'destroy', 'drop', 'truncate', 'purge', 'erase', 'trash',
  'pay', 'charge', 'transfer', 'refund', 'purchase', 'buy',
  'deploy', 'merge', 'release', 'submit', 'cancel', 'revoke', 'share', 'unsubscribe',
];

/** The words of a tool name: `gmail_send_message`, `deleteRecord`, `calendar.events.delete`. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function looksIrreversible(name: string): boolean {
  return nameWords(name).some((w) => IRREVERSIBLE.includes(w));
}

/** Argument names whose value is code or a command — read by the pre-execution scanner. */
const CODE_ARGS = ['command', 'code', 'script', 'cmd', 'shell'];

export function classify(input: RiskInput): RiskVerdict {
  const findings: PreExecFinding[] = [];
  for (const key of CODE_ARGS) {
    const value = input.args[key];
    if (typeof value === 'string') findings.push(...scanCommand(value));
  }
  let risk = input.tool.risk;
  const reversible = input.tool.reversible && !looksIrreversible(input.tool.name);
  if (!reversible && risk === 'safe') risk = 'caution';
  const verdict = (decision: RiskDecision, reason: string): RiskVerdict => ({ decision, reason, risk, reversible, findings });

  const blocked = findings.filter((f) => f.severity === 'block');
  if (blocked.length > 0) return verdict('block', `pre-execution scan blocked: ${blocked.map((f) => f.signal).join(', ')}`);
  // What warns makes a person look first, however the call was declared.
  if (findings.length > 0 && risk === 'safe') risk = 'caution';

  if (input.mode === 'plan') {
    return risk === 'safe' ? verdict('auto', 'reads only') : verdict('block', 'plan mode only reads; this changes something');
  }
  if (risk === 'safe') return verdict('auto', 'safe and reversible');
  if (risk === 'danger') return verdict('proposal', 'danger-class: a person confirms it');
  if (!reversible) return verdict('proposal', 'irreversible or outward-reaching: a person confirms it');
  if (findings.length > 0) return verdict('proposal', `the code ${findings.map((f) => f.detail).join(', ')}: a person looks first`);
  if (input.unattended) {
    return input.unattended.policy === 'trusted'
      ? verdict('auto', 'reversible, and the policy trusts unattended work')
      : verdict('proposal', 'reversible, but the policy runs only safe work unattended');
  }
  return input.mode === 'auto' ? verdict('auto', 'reversible, in auto mode') : verdict('proposal', 'caution-class: a person confirms it in ask mode');
}
