import { scan } from '@milyonuse/security';

/**
 * The skill scanner (ported from Agent 5.5 `skills/scanner.py`): every skill
 * an agent proposes or a person writes is read before it can be kept. Prose
 * goes through the injection scanner; on top of it, what a skill must never
 * teach — a destructive command, a download piped into a shell, exfiltrating
 * secrets. A `danger` verdict can never be overridden, by anyone.
 */

export type SkillVerdict = 'clean' | 'caution' | 'danger';

export interface SkillFinding {
  signal: string;
  verdict: SkillVerdict;
  detail: string;
}

const DESTRUCTIVE =
  /rm\s+-[a-z]*r[a-z]*f?\s+[/~]|shutil\.rmtree\(\s*['"][/~]|mkfs|dd\s+if=|:\(\)\s*\{.*\};:|chmod\s+-R?\s*777\s+\/|>\s*\/dev\/sd|drop\s+(table|database)|truncate\s+table|format\s+c:/i;
const PIPE_TO_SHELL = /(curl|wget)\s+[^\n|]*\|\s*(sudo\s+)?(bash|sh|zsh|python3?|node)\b/i;
const EXFILTRATION =
  /(curl|wget|nc|scp|requests\.(post|get)|fetch\()\s*[^\n]*(\.env|id_rsa|\/etc\/passwd|credential|secret|api[_-]?key|token)|base64\s+[^\n]*(\.env|id_rsa|key)|(send|post|upload|email)\s[^\n]{0,40}(api[\s_-]?keys?|passwords?|secrets?|tokens?|credentials?)/i;
const SECRET_VALUE = /\bsk-[A-Za-z0-9_-]{16,}|\bghp_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export function scanSkill(text: string): SkillFinding[] {
  const findings: SkillFinding[] = [];
  if (DESTRUCTIVE.test(text)) findings.push({ signal: 'destructive_command', verdict: 'danger', detail: 'a destructive command' });
  if (PIPE_TO_SHELL.test(text)) findings.push({ signal: 'pipe_to_interpreter', verdict: 'danger', detail: 'a download piped into an interpreter' });
  if (EXFILTRATION.test(text)) findings.push({ signal: 'exfiltration', verdict: 'danger', detail: 'sending secrets or credentials somewhere' });
  if (SECRET_VALUE.test(text)) findings.push({ signal: 'secret_value', verdict: 'danger', detail: 'a secret written into the skill' });
  // A skill is instructions by design, so "imperative" says nothing here; an
  // override, a granted authority, a credential or a hidden character still does.
  for (const f of scan(text)) {
    if (f.signal === 'imperative') continue;
    findings.push({ signal: `prose:${f.signal}`, verdict: f.severity === 'high' ? 'danger' : 'caution', detail: f.detail });
  }
  return findings;
}

export function worstVerdict(findings: readonly SkillFinding[]): SkillVerdict {
  if (findings.some((f) => f.verdict === 'danger')) return 'danger';
  if (findings.some((f) => f.verdict === 'caution')) return 'caution';
  return 'clean';
}

/** danger is never kept; caution only with a person's explicit force; clean always. */
export function mayKeep(findings: readonly SkillFinding[], options: { force?: boolean } = {}): boolean {
  const verdict = worstVerdict(findings);
  if (verdict === 'danger') return false;
  if (verdict === 'caution') return Boolean(options.force);
  return true;
}
