# API routes

> Generated from the controllers by `apps/api/src/route-inventory.test.ts` — do not edit by
> hand. Regenerate with `pnpm docs:routes`; the test suite fails when this file and the code
> disagree.

29 routes. Every path is served by `apps/api`; the web app reaches it through a
same-origin rewrite of `/api/v1`. Request and response shapes are the zod schemas in
`packages/contracts`, and every error carries a machine-readable `code` (`errors.ts`).

**Access** — what the guards require before the handler runs:

| Access | Meaning |
|---|---|
| `public` | No guard. The surface note says what authenticates it instead. |
| `session` | A signed-in session. |
| `member` | A session with a membership in the workspace — the principal. |
| `` `permission` `` | A member whose role grants that permission (`can()`, `packages/contracts/src/tenancy.ts`). |

A `· N per … per address` (or `per email`, `per member`, `in total`) suffix is the route’s rate limit
(`common/rate-limit.ts`), counted in the database so every instance agrees. Over it the
answer is 429 `rate_limited` with a `Retry-After` header.

`· Idempotency-Key` marks a route that honours the header (`modules/tenancy/idempotency.ts`):
a repeat of a successful request under the same key, by the same member, returns the first
answer with `Idempotent-Replayed: true` and runs nothing. Every POST a member can call either
honours it or is listed below with the reason it does not.

## Signing up, in and out — `/api/v1/auth`

Public, because the caller has no session yet. Registering mails a link that confirms the address; following it opens the account, a personal workspace and a session together (0002). A password signs in; a mailed link sets a new one. Registering and asking for a link answer the same for every address, and a sign-in spends the same time for an unknown address as for a known one. `session` and `logout` need a session.

| Method | Path | Access | Handler |
|---|---|---|---|
| POST | `/api/v1/auth/login` | public · 60 per 10 min per address · 5 per 10 min per email | `AuthController.login` |
| POST | `/api/v1/auth/logout` | member | `AuthController.logout` |
| POST | `/api/v1/auth/password/forgot` | public · 10 per hour per address · 3 per hour per email | `AuthController.forgotPassword` |
| POST | `/api/v1/auth/password/reset` | public · 20 per 10 min per address | `AuthController.resetPassword` |
| POST | `/api/v1/auth/register` | public · 10 per hour per address · 3 per hour per email · 500 per hour in total | `AuthController.register` |
| GET | `/api/v1/auth/session` | member | `AuthController.session` |
| POST | `/api/v1/auth/verify` | public · 20 per 10 min per address | `AuthController.verify` |

## The signed-in person — `/api/v1/me`

A session with a membership. A person’s own profile, password and sessions — no permission beyond being signed in; every change is in their workspace’s audit log.

| Method | Path | Access | Handler |
|---|---|---|---|
| GET | `/api/v1/me` | member | `MeController.me` |
| PATCH | `/api/v1/me` | member · Idempotency-Key | `MeController.update` |
| POST | `/api/v1/me/password` | member · 5 per 10 min per member | `MeController.changePassword` |
| GET | `/api/v1/me/sessions` | member | `MeController.listSessions` |
| DELETE | `/api/v1/me/sessions/:sessionId` | member | `MeController.endSession` |

## The agent — `/api/v1/agent`

A session with a membership and `agents.use`. A person’s own conversations: every read and write is scoped to the member as well as the workspace, in SQL (0006), so anyone else’s conversation is a 404. Nothing here changes anything outside the conversation. A turn and a summary spend model tokens: limited per member, and refused with `budget_exceeded` once the day’s allowance is spent. `messages/stream` answers as server-sent events.

| Method | Path | Access | Handler |
|---|---|---|---|
| GET | `/api/v1/agent` | `agents.use` | `AgentController.status` |
| GET | `/api/v1/agent/conversations` | `agents.use` | `AgentController.list` |
| POST | `/api/v1/agent/conversations` | `agents.use` · Idempotency-Key | `AgentController.create` |
| GET | `/api/v1/agent/conversations/:conversationId` | `agents.use` | `AgentController.get` |
| PATCH | `/api/v1/agent/conversations/:conversationId` | `agents.use` | `AgentController.update` |
| DELETE | `/api/v1/agent/conversations/:conversationId` | `agents.use` | `AgentController.remove` |
| POST | `/api/v1/agent/conversations/:conversationId/attachments` | `agents.use` · 30 per 10 min per member · Idempotency-Key | `AgentController.attach` |
| POST | `/api/v1/agent/conversations/:conversationId/compact` | `agents.use` · 10 per min per member · Idempotency-Key | `AgentController.compact` |
| GET | `/api/v1/agent/conversations/:conversationId/export` | `agents.use` | `AgentController.exportConversation` |
| POST | `/api/v1/agent/conversations/:conversationId/messages` | `agents.use` · 20 per min per member · Idempotency-Key | `AgentController.send` |
| POST | `/api/v1/agent/conversations/:conversationId/messages/stream` | `agents.use` · 20 per min per member | `AgentController.stream` |
| POST | `/api/v1/agent/conversations/:conversationId/stop` | `agents.use` | `AgentController.stop` |
| PUT | `/api/v1/agent/messages/:messageId/feedback` | `agents.use` | `AgentController.feedback` |
| GET | `/api/v1/agent/search` | `agents.use` | `AgentController.search` |

## Scheduled passes — `/api/v1/cron`

The host's scheduler running the workers when `WORKER_MODE=cron`. Authenticated in the handler by the `CRON_SECRET` bearer, compared in constant time; a 404 under `WORKER_MODE=interval`, where each worker keeps its own timer.

| Method | Path | Access | Handler |
|---|---|---|---|
| GET | `/api/v1/cron/:cadence` | public | `CronController.run` |

## Probes — `/health`

Outside the version prefix and unauthenticated. `live` checks nothing external; `ready` answers 503 while a dependency is down.

| Method | Path | Access | Handler |
|---|---|---|---|
| GET | `/health/live` | public | `HealthController.live` |
| GET | `/health/ready` | public | `HealthController.ready` |

## Idempotency-Key — deliberate exemptions

| Method | Path | Why not |
|---|---|---|
| POST | `/api/v1/agent/conversations/:conversationId/messages/stream` | A stream cannot be replayed; the plain messages route takes an Idempotency-Key. |
| POST | `/api/v1/agent/conversations/:conversationId/stop` | Asking to stop again is the same request; nothing is created. |
| PUT | `/api/v1/agent/messages/:messageId/feedback` | Rating again sets the same rating; nothing is created twice. |
| POST | `/api/v1/auth/login` | Carries a password. |
| POST | `/api/v1/auth/logout` | Signing out twice leaves the caller signed out once. |
| POST | `/api/v1/auth/password/forgot` | Asking twice mails a fresh link, which replaces the last. |
| POST | `/api/v1/auth/password/reset` | Carries a password and a one-time token. |
| POST | `/api/v1/auth/register` | Carries a password; registering twice mails the same link again. |
| POST | `/api/v1/auth/verify` | A one-time token, spent by the first call. |
| POST | `/api/v1/me/password` | Carries a password. |
