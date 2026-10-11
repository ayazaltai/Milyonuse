/**
 * The two messages an operator signs for a T0 (ported from Agent 5.5
 * `memory/t0.py`): staging a claim binds the content to one organization, so a
 * signature for one tenant is worthless in another; activating it names the
 * staged item and its evidence, so the second signature is for that claim and
 * no other. The database adds the five-minute gap between them (0007).
 */
export function stageMessage(organizationId: string, content: string): string {
  return `milyonuse:t0:stage:${organizationId}:${content}`;
}

export function activateMessage(itemId: string, evidenceHash: string): string {
  return `milyonuse:t0:activate:${itemId}:${evidenceHash}`;
}
