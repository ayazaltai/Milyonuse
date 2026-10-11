import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import { RATE_LIMIT_KEY, RateLimitGuard, type RateLimitRule } from './common/rate-limit.js';
import { joinPath, routeTable } from './common/route-table.js';
import { API_PREFIX, UNPREFIXED_ROUTES } from './config/routing.js';
import { SessionGuard } from './modules/identity/session.guard.js';
import { PERMISSION_KEY, PermissionGuard } from './modules/tenancy/guards/permission.guard.js';
import { PrincipalGuard } from './modules/tenancy/guards/principal.guard.js';
import { IDEMPOTENCY_EXEMPT_KEY, IDEMPOTENT_KEY } from './modules/tenancy/idempotency.js';

/**
 * The route inventory — docs/api/routes.md — read out of the application
 * itself.
 *
 * Every route, and what it takes to call it, comes from the same metadata Nest
 * routes by and the guards enforce: the module graph from AppModule down, the
 * controllers' paths and methods, the guards and the permission each one
 * names. The document is compared with it on every test run, so a route added,
 * moved or re-guarded without the document following fails the build rather
 * than sending the next reader to a path that does not exist.
 *
 * Regenerate after a deliberate change with `pnpm docs:routes`.
 */

interface Surface {
  title: string;
  /** How a caller is authenticated on this surface. */
  note: string;
  /** Whether a route here may run with no guard at all. */
  mayBeUnguarded: boolean;
}

/**
 * Keyed by the leading path segments, matched longest first, in the order the
 * document presents them. A route on a surface not described here fails the
 * suite — describing who may call it is part of adding it.
 */
const SURFACES: Record<string, Surface> = {
  auth: {
    title: 'Signing up, in and out',
    note:
      'Public, because the caller has no session yet. Registering mails a link that confirms the ' +
      'address; following it opens the account, a personal workspace and a session together (0002). ' +
      'A password signs in; a mailed link sets a new one. Registering and asking for a link answer ' +
      'the same for every address, and a sign-in spends the same time for an unknown address as for ' +
      'a known one. `session` and `logout` need a session.',
    mayBeUnguarded: true,
  },
  me: {
    title: 'The signed-in person',
    note:
      'A session with a membership. A person’s own profile, password and sessions — no permission ' +
      'beyond being signed in; every change is in their workspace’s audit log.',
    mayBeUnguarded: false,
  },
  agent: {
    title: 'The agent',
    note:
      'A session with a membership and `agents.use`. A person’s own conversations: every read and ' +
      'write is scoped to the member as well as the workspace, in SQL (0006), so anyone else’s ' +
      'conversation is a 404. A tool call that would change something outside becomes an action (0009): ' +
      'classified by the RiskEngine, recorded, and — unless safe, or reversible in auto mode — confirmed ' +
      'by the person under `actions/`, re-checked as it is then, run once. A turn and a ' +
      'summary spend model tokens: limited per member, and refused with `budget_exceeded` once the ' +
      'day’s allowance is spent. `messages/stream` answers as server-sent events.',
    mayBeUnguarded: false,
  },
  memory: {
    title: 'Verified memory',
    note:
      'A session with a membership and `agents.use`. The person’s own memory, read and changed in their ' +
      'own scope (0007): what the agent remembers, why — provenance, evidence, ledger and derivations — ' +
      'and what the person decides: add in their own words, approve, reaffirm (once a day), forget, ' +
      'withdraw a source with everything built on it. Nothing here writes a memory past its checks.',
    mayBeUnguarded: false,
  },
  connections: {
    title: 'Connected apps',
    note:
      'A session with a membership and `agents.use`. A person’s own MCP servers and Google apps (0009): ' +
      'connected by OAuth 2.1 with PKCE (or a token), their secrets sealed with AES-256-GCM and never ' +
      'answered back; disconnecting deletes the secrets in the database at once. `callback` is where the ' +
      'app sends the browser back: the authorization is used once, by the person who began it.',
    mayBeUnguarded: false,
  },
  operator: {
    title: 'Operator memory (T0)',
    note:
      'No session: the Ed25519 signature over the claim is the authentication, verified against ' +
      '`MEMORY_OPERATOR_KEYS` (public keys only; the private keys never touch the host). A claim is staged ' +
      'for one organization, and activated by a second signature at least five minutes later (0007).',
    mayBeUnguarded: true,
  },
  cron: {
    title: 'Scheduled passes',
    note:
      "The host's scheduler running the workers when `WORKER_MODE=cron`. Authenticated in the " +
      'handler by the `CRON_SECRET` bearer, compared in constant time; a 404 under ' +
      '`WORKER_MODE=interval`, where each worker keeps its own timer.',
    mayBeUnguarded: true,
  },
  health: {
    title: 'Probes',
    note:
      'Outside the version prefix and unauthenticated. `live` checks nothing external; `ready` ' +
      'answers 503 while a dependency is down.',
    mayBeUnguarded: true,
  },
};

interface Route {
  method: string;
  path: string;
  surface: string;
  access: string;
  /** The rate limits, when the route has any. */
  limit: string | null;
  /** `true` when it honours an Idempotency-Key; the reason when it deliberately does not. */
  idempotency: true | string | null;
  /** Whether a member (a principal) can call it — where the idempotency rule applies. */
  member: boolean;
  handler: string;
}

const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function guardsOf(controller: Type, handler: object): unknown[] {
  return [
    ...((Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[] | undefined) ?? []),
    ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? []),
  ];
}

/** What a caller needs to reach a handler, read from its guards and their metadata. */
function accessOf(controller: Type, handler: object): string {
  const guards = guardsOf(controller, handler);
  const known = [SessionGuard, PrincipalGuard, PermissionGuard, RateLimitGuard];
  const unknown = guards.filter((g) => !known.includes(g as never));
  if (unknown.length > 0) {
    throw new Error(`The route inventory does not know what ${String(unknown[0])} requires.`);
  }

  // Handler first, then class — the same precedence as Reflector.getAllAndOverride.
  const meta = (key: string): unknown =>
    (Reflect.getMetadata(key, handler) as unknown) ?? (Reflect.getMetadata(key, controller) as unknown);

  if (guards.includes(PermissionGuard)) {
    const permission = meta(PERMISSION_KEY) as string | undefined;
    if (permission) return `\`${permission}\``;
  }
  if (guards.includes(PrincipalGuard)) return 'member';
  if (guards.includes(SessionGuard)) return 'session';
  return 'public';
}

/** A route's rate limits, in words — `5 per 10 min per email`, `10 per hour per address`. */
function limitOf(handler: object): string | null {
  const rules = Reflect.getMetadata(RATE_LIMIT_KEY, handler) as RateLimitRule[] | undefined;
  if (!rules || rules.length === 0) return null;
  return rules
    .map((rule) => {
      const window =
        rule.windowSec === 3600
          ? 'hour'
          : rule.windowSec % 60 === 0
            ? rule.windowSec === 60
              ? 'min'
              : `${rule.windowSec / 60} min`
            : `${rule.windowSec} s`;
      const per =
        rule.per === 'address'
          ? 'per address'
          : rule.per === 'email'
            ? 'per email'
            : rule.per === 'member'
              ? 'per member'
              : 'in total';
      return `${rule.limit} per ${window} ${per}`;
    })
    .join(' · ');
}

/** The most specific surface a route belongs to — or its first segment, if none is described. */
function surfaceOf(route: string): string {
  const matches = Object.keys(SURFACES).filter(
    (key) => route === key || route.startsWith(`${key}/`),
  );
  return matches.sort((a, b) => b.length - a.length)[0] ?? route.split('/')[0]!;
}

function collectRoutes(): Route[] {
  const routes: Route[] = routeTable(AppModule).map(
    ({ method, route, controller, handler, name }) => ({
      method,
      path: `/${UNPREFIXED_ROUTES.includes(route) ? route : joinPath(API_PREFIX, route)}`,
      surface: surfaceOf(route),
      access: accessOf(controller, handler),
      limit: limitOf(handler),
      idempotency:
        Reflect.getMetadata(IDEMPOTENT_KEY, handler) === true
          ? true
          : ((Reflect.getMetadata(IDEMPOTENCY_EXEMPT_KEY, handler) as string | undefined) ??
            null),
      member: guardsOf(controller, handler).includes(PrincipalGuard),
      handler: `${controller.name}.${name}`,
    }),
  );

  return routes.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method),
  );
}

function render(routes: Route[]): string {
  const lines = [
    '# API routes',
    '',
    '> Generated from the controllers by `apps/api/src/route-inventory.test.ts` — do not edit by',
    '> hand. Regenerate with `pnpm docs:routes`; the test suite fails when this file and the code',
    '> disagree.',
    '',
    `${routes.length} routes. Every path is served by \`apps/api\`; the web app reaches it through a`,
    'same-origin rewrite of `/api/v1`. Request and response shapes are the zod schemas in',
    '`packages/contracts`, and every error carries a machine-readable `code` (`errors.ts`).',
    '',
    '**Access** — what the guards require before the handler runs:',
    '',
    '| Access | Meaning |',
    '|---|---|',
    '| `public` | No guard. The surface note says what authenticates it instead. |',
    '| `session` | A signed-in session. |',
    '| `member` | A session with a membership in the workspace — the principal. |',
    '| `` `permission` `` | A member whose role grants that permission (`can()`, `packages/contracts/src/tenancy.ts`). |',
    '',
    'A `· N per … per address` (or `per email`, `per member`, `in total`) suffix is the route’s rate limit',
    '(`common/rate-limit.ts`), counted in the database so every instance agrees. Over it the',
    'answer is 429 `rate_limited` with a `Retry-After` header.',
    '',
    '`· Idempotency-Key` marks a route that honours the header (`modules/tenancy/idempotency.ts`):',
    'a repeat of a successful request under the same key, by the same member, returns the first',
    'answer with `Idempotent-Replayed: true` and runs nothing. Every POST a member can call either',
    'honours it or is listed below with the reason it does not.',
    '',
  ];

  for (const [key, surface] of Object.entries(SURFACES)) {
    const own = routes.filter((r) => r.surface === key);
    if (own.length === 0) continue;
    const prefix = key === 'health' ? '/health' : `/${API_PREFIX}/${key}`;
    lines.push(`## ${surface.title} — \`${prefix}\``, '', surface.note, '');
    lines.push('| Method | Path | Access | Handler |', '|---|---|---|---|');
    for (const r of own) {
      const access = [r.access, r.limit, r.idempotency === true ? 'Idempotency-Key' : null]
        .filter(Boolean)
        .join(' · ');
      lines.push(`| ${r.method} | \`${r.path}\` | ${access} | \`${r.handler}\` |`);
    }
    lines.push('');
  }

  const exempt = routes.filter((r) => typeof r.idempotency === 'string');
  if (exempt.length > 0) {
    lines.push('## Idempotency-Key — deliberate exemptions', '');
    lines.push('| Method | Path | Why not |', '|---|---|---|');
    for (const r of exempt) {
      lines.push(`| ${r.method} | \`${r.path}\` | ${String(r.idempotency)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

describe('route inventory', () => {
  const routes = collectRoutes();

  it('finds the routes it is meant to describe', () => {
    const paths = routes.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('POST /api/v1/auth/register');
    expect(paths).toContain('GET /api/v1/me/sessions');
    expect(paths).toContain('GET /health/live');
  });

  it('describes every surface a route lives on', () => {
    const undescribed = [...new Set(routes.map((r) => r.surface))].filter((s) => !(s in SURFACES));
    expect(undescribed).toEqual([]);
  });

  it('leaves no route unguarded on a surface that needs a caller', () => {
    // A controller added under a signed-in surface without its guards would
    // otherwise answer anyone.
    const exposed = routes
      .filter((r) => r.access === 'public' && !SURFACES[r.surface]!.mayBeUnguarded)
      .map((r) => `${r.method} ${r.path}`);
    expect(exposed).toEqual([]);
  });

  it('makes every POST a member can call say whether it honours an Idempotency-Key', () => {
    // A retried POST without a key can run twice. Deciding is part of adding
    // the route.
    const undecided = routes
      .filter((r) => r.member && r.method === 'POST' && r.idempotency === null)
      .map((r) => `${r.method} ${r.path}`);
    expect(undecided).toEqual([]);
  });

  it('matches docs/api/routes.md', async () => {
    await expect(render(routes)).toMatchFileSnapshot('../../../docs/api/routes.md');
  });
});
