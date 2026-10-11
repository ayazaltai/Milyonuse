/**
 * Prompt-injection and poisoning scanner (ported from Agent 5.5
 * `security/injection.py`, Apache-2.0).
 *
 * Runs over untrusted text before it may be promoted to durable memory. It
 * flags; it never rewrites. A candidate that trips a medium or high signal is
 * never promoted without a person — the scanner is the floor every verifier
 * stands on.
 */

export type Severity = 'low' | 'medium' | 'high';

export interface Finding {
  signal: 'instruction_override' | 'imperative' | 'credential' | 'authority_grant' | 'invisible_unicode';
  severity: Severity;
  detail: string;
}

// Phrases that try to override earlier instructions or claim authority.
const OVERRIDE = new RegExp(
  [
    String.raw`\b(ignore|disregard|forget)\b[\s\S]{0,30}\b(previous|prior|above|earlier|all)\b`,
    String.raw`\byou are now\b`,
    String.raw`\bfrom now on\b[\s\S]{0,20}\byou (must|will|should)\b`,
    String.raw`\b(system|developer|admin)\s*(prompt|message|override)\b`,
    // Text that claims the operator's voice: an operator's policy is a signed T0, never words in a message.
    String.raw`\b(operator|system|admin)\s+(policy|policies|instruction|instructions|rule|rules|directive)\b`,
    String.raw`(operatör|sistem|yönetici)\s*(politika|talimat|kural)`,
    String.raw`önceki[\s\S]{0,20}(talimat|komut)[\s\S]{0,20}(yok say|unut|görmezden)`,
    String.raw`bundan (sonra|böyle)[\s\S]{0,20}(yapmalısın|zorundasın)`,
    String.raw`sen (artık|şimdi|bundan (sonra|böyle))[\s\S]{0,30}(asistan|ajan|agent|model|bot)`,
    String.raw`kısıtlama(sız| yok| olmadan)|sınırsız (asistan|ajan|agent|model)`,
  ].join('|'),
  'iu',
);

// Imperative, tool-triggering shapes that have no place in an observation.
const IMPERATIVE = new RegExp(
  [
    String.raw`\b(run|execute|delete|remove|send|email|curl|wget|download|upload|install|forward|exfiltrate|chmod|rm\s+-rf|drop\s+table)\b`,
    String.raw`(?<![\p{L}])(çalıştır|sil|kaldır|gönder|indir|kur|yükle|yolla|ilet|aktar)(?![\p{L}])`,
  ].join('|'),
  'iu',
);

// Credentials and secret-reading shapes.
const CREDENTIAL = new RegExp(
  [
    String.raw`\b(api[\s_-]?keys?|secrets?|tokens?|passwords?|passwd|passcodes?|credentials?|private[\s_-]?keys?)\b`,
    String.raw`\.env\b`,
    String.raw`\bsk-[a-z0-9-]{8,}`,
    String.raw`\bghp_[a-z0-9]{20,}`,
    String.raw`\bbearer\s+[a-z0-9._-]{16,}`,
    String.raw`kimlik\s*bilgi|gizli\s*anahtar|şifre(si|n|m)?\b`,
  ].join('|'),
  'iu',
);

// Attempts to grant the agent authority or waive a safeguard — the injection
// that reads like a harmless statement of policy.
const AUTHORITY = new RegExp(
  [
    String.raw`onay\s*(istemeden|almadan)|onaysız|izin\s*(istemeden|almadan|vermeden)`,
    String.raw`yetki\s*ver|kısıtlama[\s\S]{0,15}(kaldır|yok say)`,
    String.raw`without\s+(approval|permission|asking|confirmation)`,
    String.raw`bypass[\s\S]{0,15}(approval|safeguard|check|confirmation)`,
    String.raw`artık[\s\S]{0,20}(yapmalı|çalıştırmalı|yüklemeli)`,
    String.raw`(agent|ajan|asistan)[\s\S]{0,25}(onaysız|yapmalı|çalıştırmalı|zorunda)`,
    String.raw`onay\s*isteme`,
    String.raw`(agent|ajan|asistan)[\s\S]{0,35}(oku|eriş|çalıştır|yükle|sil)(abilir|abilirsin|abilirsiniz|malı|meli)`,
    String.raw`(is|are)\s+(allowed|authori[sz]ed|permitted)\s+to\b`,
  ].join('|'),
  'iu',
);

// Zero-width, bidi and other invisible characters used to smuggle
// instructions, by code point — written as numbers so the source itself holds
// none of them.
const INVISIBLE = new Set([
  0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, // zero-width space, joiners, word joiner, BOM
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // bidi embeddings and overrides
  0x2066, 0x2067, 0x2068, 0x2069, // bidi isolates
]);

/** A control character other than tab, line feed and carriage return. */
function isControl(code: number): boolean {
  return (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f);
}

function invisibleIn(text: string): string | null {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (INVISIBLE.has(code) || isControl(code)) return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return null;
}

/** Every finding for a piece of untrusted text; empty when it is clean. */
export function scan(text: string): Finding[] {
  const findings: Finding[] = [];
  const plain = text.normalize('NFKC');
  if (OVERRIDE.test(plain)) {
    findings.push({ signal: 'instruction_override', severity: 'high', detail: 'instruction-override pattern' });
  }
  if (IMPERATIVE.test(plain)) {
    findings.push({ signal: 'imperative', severity: 'medium', detail: 'an instruction, not an observation' });
  }
  if (CREDENTIAL.test(plain)) {
    findings.push({ signal: 'credential', severity: 'high', detail: 'credential or secret pattern' });
  }
  if (AUTHORITY.test(plain)) {
    findings.push({ signal: 'authority_grant', severity: 'high', detail: 'authority-grant or safeguard-bypass pattern' });
  }
  const invisible = invisibleIn(text);
  if (invisible) {
    findings.push({ signal: 'invisible_unicode', severity: 'high', detail: `invisible character ${invisible}` });
  }
  return findings;
}

const RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };

export function maxSeverity(findings: readonly Finding[]): Severity | null {
  return findings.reduce<Severity | null>(
    (worst, f) => (worst === null || RANK[f.severity] > RANK[worst] ? f.severity : worst),
    null,
  );
}

/** A candidate may be promoted without a person only when nothing medium or worse was found. */
export function isSafeForAutopromote(findings: readonly Finding[]): boolean {
  const worst = maxSeverity(findings);
  return worst === null || worst === 'low';
}
