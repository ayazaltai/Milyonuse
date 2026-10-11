import { z } from 'zod';

/**
 * Environment contract.
 *
 * Validated once at boot and never read from process.env again. A missing or
 * malformed variable takes the process down immediately with a readable
 * message, rather than surfacing as an undefined halfway through a request.
 * Every variable here is documented in .env.example (env.test.ts checks).
 */

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const flag = (defaultOn: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (defaultOn ? v !== 'false' : v === 'true'));

/** A model router's identifier — `anthropic/claude-sonnet-5-5`. Mirrors 0006's check. */
const modelId = z.string().regex(/^[A-Za-z0-9._:/~-]{1,120}$/, 'expected a model identifier such as anthropic/claude-sonnet-5-5');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),

  /**
   * Two connection strings, two roles, deliberately (db/roles.sql):
   *
   *   DATABASE_URL           milyonuse_app       — subject to RLS, used for
   *                                                everything request-scoped
   *   DATABASE_URL_PLATFORM  milyonuse_platform  — BYPASSRLS, used only by
   *                                                work before a tenant is known
   *
   * Keeping them apart is what makes the isolation auditable: grep for the
   * platform pool and you have the complete list of such code paths.
   */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_URL_PLATFORM: z.string().optional(),
  DATABASE_SSL: flag(false),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  /** How many queued jobs one process runs at once (the queue itself is a table, 0005). */
  JOBS_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),

  /**
   * How the workers are driven. `interval`: each keeps its own timer in this
   * long-lived process. `cron`: none does — the host calls
   * `GET /api/v1/cron/:cadence` on a schedule, bearing CRON_SECRET, and each
   * call runs a full pass to the end. For a host that pauses an idle process
   * (Vercel, DECISIONS D-05), where a timer would silently stop.
   */
  WORKER_MODE: z.enum(['interval', 'cron']).default('interval'),
  CRON_SECRET: z.string().min(32, 'CRON_SECRET must be at least 32 characters').optional(),

  /** Comma-separated origins permitted to call this API with credentials. */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://127.0.0.1:3000')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  /** Public origin of the web app, used to build the links account mail carries. */
  APP_BASE_URL: z.string().url().default('http://127.0.0.1:3000'),

  // ── accounts
  /**
   * Whether anyone may register. On unless a deployment says `false` — the
   * switch to pull when registrations are being abused, or for a closed beta.
   */
  SIGNUP_ENABLED: flag(true),

  SESSION_COOKIE_NAME: z.string().regex(/^[a-z_]{3,40}$/).default('mu_session'),
  SESSION_COOKIE_DOMAIN: z.string().optional(),

  // ── mail
  // Absent in development, where messages are logged instead. That fallback
  // refuses to construct in production, so an unconfigured transport there is
  // a startup failure rather than silently swallowed account links.
  SMTP_URL: z.string().optional(),
  // Or a hosted mailbox's HTTP API: the token, and where it is served.
  // MAIL_FROM's address picks the mailbox it sends from.
  MAIL_API_TOKEN: z.string().min(1).optional(),
  MAIL_API_BASE_URL: z.string().url().default('https://api.mail.hostinger.com'),
  MAIL_FROM: z.string().default('Milyonuse <no-reply@milyonuse.com>'),

  // ── the agent (D-03)
  // The model router the agent talks through. Absent in development, a
  // rule-based stand-in answers and says so; absent in production, the API
  // still starts and the agent answers 503 (agent_not_configured).
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  /** The model a new conversation uses: an OpenRouter identifier that can call tools. */
  AGENT_MODEL: modelId.default('anthropic/claude-sonnet-5-5'),
  /** The models a person may choose between, comma-separated. AGENT_MODEL is always one. */
  AGENT_MODELS: list.pipe(z.array(modelId)),
  /**
   * What people see a model called, when the tier read from its identifier is
   * not the right word: `id=Label|One line on when to use it;…`.
   */
  AGENT_MODEL_LABELS: z.string().max(4000).optional(),
  /** Tokens one person's agent may spend in a UTC day — a ceiling on accidents until plans arrive (F8). */
  AGENT_DAILY_TOKENS: z.coerce.number().int().min(1000).max(1_000_000_000).default(2_000_000),
  /** Tokens one turn may spend across its model calls before it pauses and says so. */
  AGENT_TURN_TOKENS: z.coerce.number().int().min(10_000).max(100_000_000).default(400_000),
  /**
   * Tokens of conversation the model rereads on each call. Older turns beyond
   * it are summarised by the agent and read as that summary.
   */
  AGENT_CONTEXT_TOKENS: z.coerce.number().int().min(8_000).max(400_000).default(60_000),
  /**
   * Route only to endpoints that keep nothing (the router's zero data
   * retention). On unless `false` — some models have no such endpoint.
   */
  AGENT_ZERO_RETENTION: flag(true),

  // ── verified memory (Phase 2)
  /** The embeddings model, through the same router; absent a key, a deterministic FNV-1a embedder serves. */
  MEMORY_EMBEDDING_MODEL: modelId.default('openai/text-embedding-3-small'),
  /**
   * Who checks a memory before it is kept: `model` asks the Fast-tier model
   * after the rules (when the router is configured), `rules` only the rules.
   */
  MEMORY_VERIFIER: z.enum(['model', 'rules']).default('model'),
  /**
   * The operators' Ed25519 public keys, each a base64-encoded PEM,
   * comma-separated. The only way to an operator's T0 memory; absent, none
   * can be written.
   */
  MEMORY_OPERATOR_KEYS: list.pipe(
    z.array(z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'MEMORY_OPERATOR_KEYS must list base64-encoded PEM keys')),
  ),

  // ── tools and connections (F3)
  /**
   * The keys connection secrets are encrypted with (AES-256-GCM), as
   * `version:base64` pairs, comma-separated; the highest version encrypts and
   * every listed one decrypts, so a key is rotated by adding the next.
   * Required in production; development and tests use a fixed stand-in.
   */
  SECRETS_KEYS: list.pipe(
    z.array(z.string().regex(/^[1-9]\d{0,3}:[A-Za-z0-9+/]{43}=$/, 'SECRETS_KEYS must list version:base64 pairs of 32-byte keys')),
  ),
  /** Where web_search asks: a keyless fallback, or a provider with its key. */
  WEB_SEARCH_PROVIDER: z.enum(['duckduckgo', 'brave', 'tavily']).default('duckduckgo'),
  BRAVE_API_KEY: z.string().min(1).optional(),
  TAVILY_API_KEY: z.string().min(1).optional(),
  /**
   * Where code_run runs code: Vercel Sandbox, a local child process
   * (development only — it is not isolated), or nowhere.
   */
  SANDBOX_PROVIDER: z.enum(['none', 'local', 'vercel']).default('none'),
  /** Vercel Sandbox credentials: an OIDC token on Vercel, or a token with the team and project elsewhere. */
  VERCEL_OIDC_TOKEN: z.string().min(1).optional(),
  VERCEL_TOKEN: z.string().min(1).optional(),
  VERCEL_TEAM_ID: z.string().min(1).optional(),
  VERCEL_PROJECT_ID: z.string().min(1).optional(),
  /** Seconds one code run may take. */
  SANDBOX_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(600).default(60),
  /** Sandbox minutes a person may use a day. */
  SANDBOX_DAILY_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  /** Google's OAuth client, for Gmail, Calendar and Drive. Unset, those cards say they are not available. */
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

  // ── operations
  /**
   * Who hears when something breaks: a digest of new errors from the system
   * log, at most one every fifteen minutes. Comma-separated. Unset, nothing is
   * mailed — the log is still kept.
   */
  ALERT_EMAILS: list.pipe(z.array(z.string().email('ALERT_EMAILS must be a comma-separated list of addresses'))),
  /** Days a system log line is kept before the hourly pass deletes it. */
  LOG_RETENTION_DAYS: z.coerce.number().int().min(7).max(730).default(90),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }

  const env = result.data;

  if (env.NODE_ENV === 'production' && !env.SMTP_URL && !env.MAIL_API_TOKEN) {
    throw new Error(
      'Invalid environment configuration:\n' +
        '  SMTP_URL or MAIL_API_TOKEN is required in production. Without a\n' +
        '  transport, confirmation and password links would be written to the\n' +
        '  log and nobody could register or recover an account.',
    );
  }

  if (env.WORKER_MODE === 'cron' && !env.CRON_SECRET) {
    throw new Error(
      'Invalid environment configuration:\n' +
        '  WORKER_MODE=cron needs CRON_SECRET. Without it nothing could call the\n' +
        '  workers, and no queued job or scheduled pass would ever run.',
    );
  }

  if (env.NODE_ENV === 'production' && !env.DATABASE_URL_PLATFORM) {
    throw new Error(
      'Invalid environment configuration:\n' +
        '  DATABASE_URL_PLATFORM is required in production. Registration, session\n' +
        '  lookup and the queue run before a tenant is known and need the platform\n' +
        '  role; falling back to the application role would fail every one of them.',
    );
  }

  if (env.NODE_ENV === 'production' && env.SECRETS_KEYS.length === 0) {
    throw new Error(
      'Invalid environment configuration:\n' +
        '  SECRETS_KEYS is required in production. Connection secrets would\n' +
        '  otherwise be encrypted with the development stand-in key.',
    );
  }

  if (env.NODE_ENV === 'production' && env.SANDBOX_PROVIDER === 'local') {
    throw new Error(
      'Invalid environment configuration:\n' +
        '  SANDBOX_PROVIDER=local runs code on the API host, unisolated. It is for\n' +
        '  development only; use vercel or none in production.',
    );
  }

  return env;
}
