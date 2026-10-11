import type { AgentModelOption, AgentModelTier } from '@milyonuse/contracts';

/**
 * Models in plain words (ported from App-Milyonus `modules/agent/models.ts`;
 * D-03: Fast, Balanced and Deep tiers).
 *
 * A person choosing how the agent thinks should not have to read a router's
 * identifier. Each offered model has a tier, read from its identifier, and a
 * line on when to use it; a deployment can name any of them differently with
 * AGENT_MODEL_LABELS (`id=Label|Description;…`).
 */

const TIERS: Record<AgentModelTier, { label: string; description: string }> = {
  fast: {
    label: 'Fast',
    description: 'Quick answers and simple tasks; the lightest on the allowance.',
  },
  balanced: {
    label: 'Balanced',
    description: 'Good for most work: writing, planning and working with files.',
  },
  deep: {
    label: 'Deep',
    description: 'For hard reasoning and long, many-step work; slower and heavier on the allowance.',
  },
};

/** The tier an identifier reads as. */
export function tierOf(id: string): AgentModelTier {
  // Words, not substrings: "gemini" holds "mini", and is not a small model for it.
  const words = (id.toLowerCase().split('/').at(-1) ?? id.toLowerCase()).split(/[-._:]/);
  if (words.some((w) => ['haiku', 'mini', 'flash', 'nano', 'lite', 'small'].includes(w)))
    return 'fast';
  if (words.some((w) => ['opus', 'pro', 'o1', 'o3', 'ultra', 'large'].includes(w))) return 'deep';
  return 'balanced';
}

/** `AGENT_MODEL_LABELS` read: id → its label and line. Malformed entries are skipped. */
export function parseLabels(
  raw: string | undefined,
): Map<string, { label: string; description?: string }> {
  const labels = new Map<string, { label: string; description?: string }>();
  for (const entry of (raw ?? '').split(';')) {
    const at = entry.indexOf('=');
    if (at <= 0) continue;
    const id = entry.slice(0, at).trim();
    const [label, description] = entry
      .slice(at + 1)
      .split('|')
      .map((s) => s.trim());
    if (!id || !label) continue;
    labels.set(id, {
      label: label.slice(0, 40),
      ...(description ? { description: description.slice(0, 160) } : {}),
    });
  }
  return labels;
}

/** The deployment's models as options. Two models of one tier are told apart by their name. */
export function modelOptions(
  ids: readonly string[],
  rawLabels: string | undefined,
): AgentModelOption[] {
  const labels = parseLabels(rawLabels);
  const tiers = ids.map(tierOf);
  return ids.map((id, i) => {
    const tier = tiers[i]!;
    const own = labels.get(id);
    const shared = tiers.filter((t) => t === tier).length > 1;
    const short = id.split('/').at(-1) ?? id;
    return {
      id,
      tier,
      label: own?.label ?? (shared ? `${TIERS[tier].label} · ${short}` : TIERS[tier].label),
      description: own?.description ?? TIERS[tier].description,
    };
  });
}

/**
 * The models this deployment offers, in the order AGENT_MODELS lists them:
 * the default always among them, and first when the list leaves it out.
 */
export function offeredModels(env: { AGENT_MODEL: string; AGENT_MODELS: readonly string[] }): string[] {
  const listed = [...new Set(env.AGENT_MODELS)];
  return listed.includes(env.AGENT_MODEL) ? listed : [env.AGENT_MODEL, ...listed];
}
