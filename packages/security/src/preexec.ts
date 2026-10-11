/**
 * Pre-execution scanner (ported from Agent 5.5 `security/preexec.py`, Apache-2.0).
 *
 * Reads code or a command before it runs — in the sandbox, which already has
 * no network and no secrets — and finds what should never run (a fork bomb,
 * deleting the root, piping a download into a shell, formatting a disk) and
 * what a person should see first. Distinct from the injection scanner: this
 * reads what is about to run, not what is about to be believed.
 */

export type PreExecSeverity = 'warn' | 'block';

export interface PreExecFinding {
  signal: string;
  severity: PreExecSeverity;
  detail: string;
}

const BLOCK: readonly [string, RegExp, string][] = [
  ['fork_bomb', /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'fork bomb'],
  ['recursive_root_delete', /rm\s+-[a-z]*r[a-z]*\s+(--no-preserve-root\s+)?(\/|~|\$HOME)(\*|\s|$)/i, 'recursive delete of the root or home directory'],
  ['mkfs', /\bmkfs(\.\w+)?\s/, 'filesystem format'],
  ['disk_overwrite', /\bdd\s+if=.*\s+of=\/dev\/(sd|nvme|disk|hd|xvd)/, 'disk overwrite'],
  ['pipe_to_shell', /(curl|wget)\s+[^\n|]*\|\s*(sudo\s+)?(bash|sh|zsh|python3?|node)\b/i, 'download piped into an interpreter'],
  ['python_root_delete', /shutil\.rmtree\(\s*['"](\/|~)['"]/, 'recursive delete of the root or home directory'],
];

const WARN: readonly [string, RegExp, string][] = [
  ['chmod_777', /chmod\s+(-R\s+)?777/, 'overly broad permissions (777)'],
  ['sudo', /\bsudo\b/, 'elevated privilege'],
  ['unguarded_delete', /\brm\s+-[a-z]*r/i, 'recursive delete'],
  ['db_drop', /\bdrop\s+(table|database|schema)\b/i, 'database drop'],
  ['network', /\b(curl|wget|requests\.(get|post)|urllib|fetch\(|http\.client|socket\.)/i, 'network access'],
  ['subprocess', /\b(subprocess|os\.system|child_process|exec(Sync)?\()/, 'starts another process'],
  ['env_read', /(\bos\.environ\b|\bprocess\.env\b|\.env\b|printenv|\benv\b\s*$)/m, 'reads the environment'],
];

export function scanCommand(code: string): PreExecFinding[] {
  const findings: PreExecFinding[] = [];
  for (const [signal, pattern, detail] of BLOCK) if (pattern.test(code)) findings.push({ signal, severity: 'block', detail });
  for (const [signal, pattern, detail] of WARN) if (pattern.test(code)) findings.push({ signal, severity: 'warn', detail });
  return findings;
}
