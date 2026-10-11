import { MEMORY_POLICY, type Sensitivity, type TrustTier } from './types.js';

/**
 * Trust that decays (ported from Agent 5.5 `memory/trust.py`).
 *
 * Promotion grants time-boxed trust, not permanent belief: a memory's trust
 * halves every half-life since it was last reaffirmed, and when it falls below
 * the floor consolidation demotes it. Trust that is not re-earned falls on its
 * own, so a poisoned or stale memory does not quietly become tomorrow's
 * default. An operator's T0 never decays: it is authority, not a claim.
 */

const DAY_MS = 86_400_000;

export function halfLifeMs(tier: TrustTier, sensitivity: Sensitivity = 'normal'): number | null {
  const days = MEMORY_POLICY.halfLifeDays[tier];
  if (days === null) return null;
  return days * DAY_MS * (sensitivity === 'sensitive' ? MEMORY_POLICY.sensitiveFactor : 1);
}

/** Trust in [0, 1]: ceiling × 0.5^(age / half-life), from the last reaffirmation. */
export function currentTrust(input: {
  tier: TrustTier;
  ceiling: number;
  sensitivity: Sensitivity;
  /** Last reaffirmation, else the promotion, else the write. */
  since: Date;
  now?: Date;
}): number {
  const half = halfLifeMs(input.tier, input.sensitivity);
  if (half === null) return 1;
  const age = Math.max(0, (input.now ?? new Date()).getTime() - input.since.getTime());
  return input.ceiling * 0.5 ** (age / half);
}

/**
 * Sensitive memory decays four times as fast: a stale "the agent may pay
 * without asking" is far more dangerous than a stale "likes dark mode". What
 * touches authority and security, and what is personal in the sense the law
 * protects — health, money, identity, where someone is — in English and Turkish.
 */
const SENSITIVE = [
  // authority and security
  'approval', 'approve', 'permission', 'permit', 'access', 'credential', 'secret', 'token', 'password', 'delete',
  'deploy', 'security', 'admin', 'authoriz', 'grant', 'bypass', 'disable', 'override', 'without confirm',
  'onaysız', 'onay', 'yetki', 'erişim', 'şifre', 'parola', 'güvenlik', 'izin',
  // health
  'diagnos', 'illness', 'disease', 'medication', 'prescription', 'therapy', 'pregnan', 'allerg', 'blood type',
  'hastalık', 'teşhis', 'ilaç', 'reçete', 'tedavi', 'hamile', 'alerji', 'kan grubu',
  // money
  'salary', 'income', 'debt', 'loan', 'bank account', 'iban', 'credit card', 'card number', 'mortgage',
  'maaş', 'gelir', 'borç', 'kredi', 'banka hesab', 'kredi kart', 'kart numara',
  // identity
  'passport', 'national id', 'social security', 'ssn', 'tax number', 'date of birth',
  'pasaport', 'kimlik no', 'tc kimlik', 'vergi numara', 'doğum tarih',
  // location
  'home address', 'lives at', 'address is', 'location', 'gps',
  'ev adres', 'adresi', 'adresim', 'konum',
];

export function classifySensitivity(content: string): Sensitivity {
  const low = content.toLocaleLowerCase('tr');
  return SENSITIVE.some((w) => low.includes(w)) ? 'sensitive' : 'normal';
}

/**
 * The ceiling a reaffirmation restores. The operator's (strong, signed) restores
 * full trust; the person's own (weak) loses a tenth for each one past the third,
 * never below the floor — so a patient attacker cannot keep a memory at full
 * trust by asking for it again and again.
 */
export function reaffirmCeiling(reaffirmCount: number, signal: 'weak' | 'strong'): number {
  if (signal === 'strong') return 1;
  return Math.max(MEMORY_POLICY.weakReaffirmFloor, 1 - 0.1 * Math.max(0, reaffirmCount - 3));
}

/**
 * The ceiling a demoted memory returns under: lower than before, always
 * (0007 refuses an equal one) — trust lost to decay is earned back partly.
 */
export function repromotionCeiling(previous: number): number {
  return Math.max(0.1, Math.round(previous * 0.8 * 1000) / 1000);
}
