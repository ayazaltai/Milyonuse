import Image from 'next/image';

/**
 * The product's lockup: the Milyonus mark beside the Milyonuse name. The
 * registered Milyonus wordmark spells the company, not this product, so the
 * name is set in type rather than borrowed from that artwork.
 */
export function Lockup({ size = 28, byline }: { size?: number; byline?: string | undefined }) {
  return (
    <span className="mk-lockup">
      <Image src="/brand/milyonus-mark.png" alt="" width={size} height={size} priority />
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
        <span className="mk-lockup-name">Milyonuse</span>
        {byline && <span className="mk-lockup-by">{byline}</span>}
      </span>
    </span>
  );
}
