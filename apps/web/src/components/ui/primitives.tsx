import type { ReactNode } from 'react';

/**
 * The platform's building blocks.
 *
 * Styling lives in packages/ui/tokens.css as semantic classes rather than in
 * per-component inline objects. That is how the marketing site is built and
 * how trading.milyonus.com carries the same language — one stylesheet holds
 * the design, and components compose it.
 */

/* ────────────────────────────────────────────────────────────── headings */

/**
 * The two-line heading pattern from design.md: an upright line followed by an
 * italic accent. The marketing site sets the accent in a serif; the platform
 * builds it from the same family by weight and slant — Montserrat 500 upright
 * over 300 italic (App-Milyonus Action-Plan §4.4). It appears on every page of every
 * Milyonus surface, and it is the single strongest signal that this is the
 * same product as the marketing site.
 */
export function PageHead({
  eyebrow,
  title,
  accent,
  lead,
  actions,
}: {
  eyebrow: string;
  title: string;
  accent: string;
  lead?: string | undefined;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div
        style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20 }}
      >
        <div style={{ minWidth: 0 }}>
          <p className="eyebrow">{eyebrow}</p>
          <h1 className="page-title">
            {title}{' '}
            <span className="accent" style={{ color: 'var(--w-65)' }}>
              {accent}
            </span>
          </h1>
          {lead && <p className="page-lead">{lead}</p>}
        </div>
        {actions}
      </div>
    </header>
  );
}

/* ─────────────────────────────────────────────────────────────── surfaces */

/** The platform's default surface: frosted glass over pure black. */
export function Panel({
  title,
  description,
  actions,
  children,
  flush = false,
  style,
}: {
  title?: string | undefined;
  description?: string | undefined;
  actions?: ReactNode;
  children: ReactNode;
  /** Let a table run to the panel edge instead of sitting inside its padding. */
  flush?: boolean;
  style?: React.CSSProperties;
}) {
  if (flush) {
    return (
      <section className="glass glass-flush" style={style}>
        {(title || actions) && (
          <header
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              padding: '18px 24px',
              borderBottom: '1px solid var(--w-08)',
            }}
          >
            <div>
              {title && <p className="eyebrow">{title}</p>}
              {description && (
                <p style={{ fontSize: 12.5, color: 'var(--w-35)', margin: '6px 0 0' }}>
                  {description}
                </p>
              )}
            </div>
            {actions}
          </header>
        )}
        {children}
      </section>
    );
  }

  return (
    <section className="glass" style={style}>
      {(title || actions) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 16,
            marginBottom: description ? 6 : 16,
          }}
        >
          <div>
            {title && <p className="eyebrow">{title}</p>}
            {description && (
              <p style={{ fontSize: 12.5, color: 'var(--w-35)', margin: '8px 0 0', lineHeight: 1.55 }}>
                {description}
              </p>
            )}
          </div>
          {actions}
        </div>
      )}
      <div style={title || actions ? { marginTop: 16 } : undefined}>{children}</div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────── controls */

type ButtonVariant = 'primary' | 'secondary' | 'brand' | 'danger' | 'ghost';

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
}) {
  return (
    <button
      {...props}
      className={['pill', `pill-${variant}`, size === 'sm' ? 'pill-sm' : '', className]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? (
        <span className="field-error">{error}</span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </label>
  );
}

/**
 * A checkbox with its sentence — a setting switched on, an event subscribed
 * to. The whole line is the hit area, not the 15px box.
 */
export function Checkbox({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  hint?: string | undefined;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="checkline" style={disabled ? { cursor: 'not-allowed', opacity: 0.55 } : undefined}>
      <input
        type="checkbox"
        className="check"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint && <span className="checkline-hint">{hint}</span>}
      </span>
    </label>
  );
}

/* ──────────────────────────────────────────────────────────────── display */

type Tone = 'neutral' | 'brand' | 'pass' | 'review' | 'danger';

/**
 * Status always carries its own label. Colour is a second channel, never the
 * only one — the word is what a colourblind reader, a printout and a screen
 * reader all get.
 */
export function Tag({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`tag${tone === 'neutral' ? '' : ` tag-${tone}`}`}>{children}</span>;
}

export function Notice({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <div role="status" className={`notice${tone === 'neutral' ? '' : ` notice-${tone}`}`}>
      {children}
    </div>
  );
}

const count = new Intl.NumberFormat('en-GB');

/**
 * One value against one limit.
 *
 * A meter, not a chart: the number is the point, and a single-hue fill reads
 * magnitude at a glance. It turns amber only at capacity, where "none left" is
 * the thing an administrator needs to notice.
 */
export function Meter({ label, value, limit }: { label: string; value: number; limit: number }) {
  const ratio = limit === 0 ? 0 : Math.min(1, value / limit);
  const full = limit > 0 && value >= limit;

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 12.5, color: 'var(--w-60)' }}>{label}</span>
        <span style={{ fontSize: 12.5, color: 'var(--w-35)' }}>
          <span style={{ color: 'var(--fg)' }}>{count.format(value)}</span> / {count.format(limit)}
        </span>
      </div>
      <div
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-label={`${label}: ${value} of ${limit}`}
        className="meter-track"
      >
        <div
          className={`meter-fill${full ? ' meter-fill-full' : ''}`}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}

export function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail?: string | undefined;
}) {
  return (
    <div>
      <p className="eyebrow" style={{ fontSize: 10.5 }}>
        {label}
      </p>
      <p
        style={{
          fontSize: 'clamp(28px, 3vw, 34px)',
          fontWeight: 400,
          letterSpacing: '-0.02em',
          margin: '10px 0 0',
          lineHeight: 1.05,
        }}
      >
        {value}
      </p>
      {detail && (
        <p style={{ fontSize: 12.5, color: 'var(--w-35)', margin: '6px 0 0' }}>{detail}</p>
      )}
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────── tables */

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="table-wrap">
      <table className="data-table">{children}</table>
    </div>
  );
}

export function Th({ children, num }: { children?: ReactNode; num?: boolean }) {
  return <th className={num ? 'num' : undefined}>{children}</th>;
}

export function Td({
  children,
  num,
  nowrap,
  muted,
}: {
  children?: ReactNode;
  num?: boolean;
  nowrap?: boolean;
  muted?: boolean;
}) {
  return (
    <td
      className={[num ? 'num' : '', nowrap ? 'nowrap' : ''].filter(Boolean).join(' ') || undefined}
      style={muted ? { color: 'var(--w-35)' } : undefined}
    >
      {children}
    </td>
  );
}

/** Two-line table cell: the thing, and what qualifies it. */
export function CellPair({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <div className="cell-title">{title}</div>
      {sub && <div className="cell-sub">{sub}</div>}
    </div>
  );
}

export function Empty({ title, description }: { title: string; description?: string | undefined }) {
  return (
    <div style={{ padding: '44px 24px', textAlign: 'center' }}>
      <p style={{ fontSize: 14, color: 'var(--w-65)', margin: 0 }}>{title}</p>
      {description && (
        <p
          style={{
            fontSize: 13,
            color: 'var(--w-35)',
            margin: '8px auto 0',
            maxWidth: 430,
            lineHeight: 1.6,
          }}
        >
          {description}
        </p>
      )}
    </div>
  );
}
