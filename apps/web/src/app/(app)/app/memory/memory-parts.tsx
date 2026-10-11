import type { MemoryItemView } from '@milyonuse/contracts';

/** Tone of a memory's state: kept is a pass, what waits needs attention, what went is quiet. */
export function stateTone(state: MemoryItemView['state']): 'pass' | 'review' | 'danger' | 'neutral' {
  if (state === 'active') return 'pass';
  if (state === 'pending' || state === 'demoted' || state === 't0_staged') return 'review';
  if (state === 'rejected') return 'danger';
  return 'neutral';
}

export function TrustBar({ trust, label }: { trust: number; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 120 }}>
      <div role="meter" aria-valuenow={trust} aria-valuemin={0} aria-valuemax={1} aria-label={label} className="meter-track" style={{ flex: 1 }}>
        <div className={`meter-fill${trust < 0.5 ? ' meter-fill-full' : ''}`} style={{ width: `${Math.round(trust * 100)}%` }} />
      </div>
      <span style={{ fontSize: 12.5, color: 'var(--w-60)', fontVariantNumeric: 'tabular-nums' }}>{trust.toFixed(2)}</span>
    </div>
  );
}
