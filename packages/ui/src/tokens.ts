/**
 * Token values mirrored for TypeScript consumers — chart palettes, PDF report
 * generation, canvas rendering: anywhere a value is needed outside CSS.
 *
 * tokens.css is the source of truth for anything the browser paints. This file
 * exists so those other renderers do not invent their own blues.
 */

export const brand = {
  400: '#4c86ff',
  500: '#2e6bff',
  600: '#1746c8',
  900: '#061c5e',
  cyan: '#5cc8ff',
} as const;

export const semantic = {
  pass: '#22c55e',
  review: '#f5a524',
  danger: '#e1483c',
} as const;

export const ground = {
  ink: '#000000',
  fg: '#ffffff',
} as const;

/**
 * The white opacity scale. Everything that is not brand or semantic is a step
 * on this — one scale rather than separate surface, border and text ramps.
 */
export const white = {
  95: 'rgba(255,255,255,0.95)',
  80: 'rgba(255,255,255,0.8)',
  70: 'rgba(255,255,255,0.7)',
  65: 'rgba(255,255,255,0.65)',
  60: 'rgba(255,255,255,0.6)',
  50: 'rgba(255,255,255,0.5)',
  35: 'rgba(255,255,255,0.35)',
  20: 'rgba(255,255,255,0.2)',
  14: 'rgba(255,255,255,0.14)',
  10: 'rgba(255,255,255,0.1)',
  '08': 'rgba(255,255,255,0.08)',
  '06': 'rgba(255,255,255,0.06)',
  '03': 'rgba(255,255,255,0.03)',
} as const;

/**
 * The faces (DECISIONS D-07). The app runs on Montserrat alone and builds the
 * heading pair from weight and slant; the marketing pages pair Inter Tight
 * with Instrument Serif. Anything rendering outside the browser — a PDF, a
 * generated image — uses the app's family so it looks like the screen it came
 * from.
 */
export const fontFamily = {
  sans: "'Montserrat', system-ui, -apple-system, sans-serif",
  marketing: "'Inter Tight', system-ui, -apple-system, sans-serif",
  marketingAccent: "'Instrument Serif', Georgia, serif",
} as const;

/** Heading pair: upright line, then the accent. */
export const headingPair = {
  primary: { weight: 500, letterSpacing: '-0.02em' },
  accent: { weight: 300, fontStyle: 'italic', letterSpacing: '-0.01em' },
} as const;

export const radius = {
  card: 20,
  control: 10,
  pill: 9999,
} as const;

export const motion = {
  ease: 'cubic-bezier(0.22, 1, 0.36, 1)',
} as const;

export const layout = {
  sidebarWidth: 248,
  pageMax: 1100,
  contentMax: 1200,
} as const;
