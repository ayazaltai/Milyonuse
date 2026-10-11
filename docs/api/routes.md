# API routes

> Generated from the controllers by `apps/api/src/route-inventory.test.ts` — do not edit by
> hand. Regenerate with `pnpm docs:routes`; the test suite fails when this file and the code
> disagree.

73 routes. Every path is served by `apps/api`; the web app reaches it through a
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

A session with a membership and `agents.use`. A person’s own conversations: every read and write is scoped to the member as well as the workspace, in SQL (0006), so anyone else’s conversation is a 404. A tool call that would change something outside becomes an action (0009): classified by the RiskEngine, recorded, and — unless safe, or reversible in auto mode — confirmed by the person under `actions/`, re-checked as it is then, run once. A turn and a summary spend model tokens: limited per member, and refused with `budget_exceeded` once the day’s allowance is spent. `messages/stream` answers as server-sent events.

| Method | Path | Access | Handler |
|---|---|---|---|
| GET | `/api/v1/agent` | `agents.use` | `AgentController.status` |
| GET | `/api/v1/agent/actions` | `agents.use` | `ActionController.list` |
| GET | `/api/v1/agent/actions/:actionId` | `agents.use` | `ActionController.get` |
| POST | `/api/v1/agent/actions/:actionId/confirm` | `agents.use` · 30 per min per member | `ActionController.confirm` |
| POST | `/api/v1/agent/actions/:actionId/discard` | `agents.use` | `ActionController.discard` |
| POST | `/api/v1/agent/actions/:actionId/undo` | `agents.use` · 30 per min per member | `ActionController.undo` |
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
| GET | `/api/v1/agent/files/:fileId` | `agents.use` | `FileController.download` |
| PUT | `/api/v1/agent/messages/:messageId/feedback` | `agents.use` | `AgentController.feedback` |
| GET | `/api/v1/agent/search` | `agents.use` | `AgentController.search` |

## The agent studio — `/api/v1/agents`

A session with a membership and `agents.use`. A person’s own agents (0010), from a template or from nothing. Changing what an agent is writes a new version — numbered by the database and never changed — and every answer names the version that wrote it; name, face and role title change in place. An agent is archived, never deleted. Anyone else’s agent is a 404.

| Method | Path | Access | Handler |
|---|---|---|---|
| GET | `/api/v1/agents` | `agents.use` | `StudioController.list` |
| POST | `/api/v1/agents` | `agents.use` · Idempotency-Key | `StudioController.create` |
| GET | `/api/v1/agents/:agentId` | `agents.use` | `StudioController.get` |
| PATCH | `/api/v1/agents/:agentId` | `agents.use` | `StudioController.update` |
| POST | `/api/v1/agents/:agentId/archive` | `agents.use` | `StudioController.archive` |
| POST | `/api/v1/agents/:agentId/restore` | `agents.use` | `StudioController.restore` |
| GET | `/api/v1/agents/:agentId/versions` | `agents.use` | `StudioController.versions` |
| GET | `/api/v1/agents/templates` | `agents.use` | `StudioController.templates` |
| GET | `/api/v1/agents/tools` | `agents.use` | `StudioController.tools` |

## Skills — `/api/v1/skills`

A session with a membership and `agents.use`. A person’s skills (0010): the reviewed bundled ones, the ones they write and the ones their agents learn. Every version but a bundled one is scanned and staged; a danger verdict is final. A staged version becomes active only after a replay in the queue passes and the person approves it — the database refuses it otherwise — and falls with any source it was learned from.

| Method | Path | Access | Handler |
|---|---|---|---|
| GET | `/api/v1/skills` | `agents.use` | `SkillsController.list` |
| POST | `/api/v1/skills` | `agents.use` · 20 per min per member · Idempotency-Key | `SkillsController.write` |
| GET | `/api/v1/skills/:skillId` | `agents.use` | `SkillsController.get` |
| PATCH | `/api/v1/skills/:skillId` | `agents.use` | `SkillsController.update` |
| POST | `/api/v1/skills/bundled` | `agents.use` · Idempotency-Key | `SkillsController.addBundled` |
| GET | `/api/v1/skills/catalogue` | `agents.use` | `SkillsController.catalogue` |
| POST | `/api/v1/skills/versions/:versionId/approve` | `agents.use` | `SkillsController.approve` |
| POST | `/api/v1/skills/versions/:versionId/reject` | `agents.use` | `SkillsController.reject` |
| POST | `/api/v1/skills/versions/:versionId/replay` | `agents.use` · 10 per min per member | `SkillsController.replay` |

## Verified memory — `/api/v1/memory`

A session with a membership and `agents.use`. The person’s own memory, read and changed in their own scope (0007): what the agent remembers, why — provenance, evidence, ledger and derivations — and what the person decides: add in their own words, approve, reaffirm (once a day), forget, withdraw a source with everything built on it. Nothing here writes a memory past its checks.

| Method | Path | Access | Handler |
|---|---|---|---|
| GET | `/api/v1/memory` | `agents.use` | `MemoryController.list` |
| POST | `/api/v1/memory` | `agents.use` · 30 per 10 min per member · Idempotency-Key | `MemoryController.create` |
| GET | `/api/v1/memory/:memoryId` | `agents.use` | `MemoryController.detail` |
| POST | `/api/v1/memory/:memoryId/approve` | `agents.use` | `MemoryController.approve` |
| POST | `/api/v1/memory/:memoryId/forget` | `agents.use` | `MemoryController.forget` |
| POST | `/api/v1/memory/:memoryId/keep` | `agents.use` | `MemoryController.keep` |
| POST | `/api/v1/memory/:memoryId/reaffirm` | `agents.use` | `MemoryController.reaffirm` |
| GET | `/api/v1/memory/ledger` | `agents.use` | `MemoryController.ledger` |
| POST | `/api/v1/memory/revocations` | `agents.use` | `MemoryController.revoke` |
| GET | `/api/v1/memory/revocations/preview` | `agents.use` | `MemoryController.preview` |

## Connected apps — `/api/v1/connections`

A session with a membership and `agents.use`. A person’s own MCP servers and Google apps (0009): connected by OAuth 2.1 with PKCE (or a token), their secrets sealed with AES-256-GCM and never answered back; disconnecting deletes the secrets in the database at once. `callback` is where the app sends the browser back: the authorization is used once, by the person who began it.

| Method | Path | Access | Handler |
|---|---|---|---|
| GET | `/api/v1/connections` | `agents.use` | `ConnectionsController.list` |
| POST | `/api/v1/connections` | `agents.use` · 20 per 10 min per member | `ConnectionsController.start` |
| GET | `/api/v1/connections/:connectionId` | `agents.use` | `ConnectionsController.get` |
| PATCH | `/api/v1/connections/:connectionId` | `agents.use` | `ConnectionsController.update` |
| DELETE | `/api/v1/connections/:connectionId` | `agents.use` | `ConnectionsController.revoke` |
| POST | `/api/v1/connections/:connectionId/refresh` | `agents.use` · 20 per 10 min per member | `ConnectionsController.refresh` |
| GET | `/api/v1/connections/apps` | `agents.use` | `ConnectionsController.apps` |
| GET | `/api/v1/connections/callback` | `agents.use` · 30 per 10 min per member | `ConnectionsController.callback` |

## Operator memory (T0) — `/api/v1/operator`

No session: the Ed25519 signature over the claim is the authentication, verified against `MEMORY_OPERATOR_KEYS` (public keys only; the private keys never touch the host). A claim is staged for one organization, and activated by a second signature at least five minutes later (0007).

| Method | Path | Access | Handler |
|---|---|---|---|
| POST | `/api/v1/operator/memory/activate` | public · 20 per hour per address | `OperatorController.activate` |
| POST | `/api/v1/operator/memory/stage` | public · 20 per hour per address | `OperatorController.stage` |

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
| POST | `/api/v1/agent/actions/:actionId/confirm` | A proposal runs at most once by the database; a second confirm is refused, not repeated. |
| POST | `/api/v1/agent/actions/:actionId/discard` | Discarding a discarded proposal is refused by the database, not repeated. |
| POST | `/api/v1/agent/actions/:actionId/undo` | One undo per action: a second is refused while the first stands. |
| POST | `/api/v1/agent/conversations/:conversationId/messages/stream` | A stream cannot be replayed; the plain messages route takes an Idempotency-Key. |
| POST | `/api/v1/agent/conversations/:conversationId/stop` | Asking to stop again is the same request; nothing is created. |
| PUT | `/api/v1/agent/messages/:messageId/feedback` | Rating again sets the same rating; nothing is created twice. |
| POST | `/api/v1/agents/:agentId/archive` | Archiving sets a state; doing it twice leaves the same state. |
| POST | `/api/v1/agents/:agentId/restore` | Restoring sets a state; doing it twice leaves the same state. |
| POST | `/api/v1/auth/login` | Carries a password. |
| POST | `/api/v1/auth/logout` | Signing out twice leaves the caller signed out once. |
| POST | `/api/v1/auth/password/forgot` | Asking twice mails a fresh link, which replaces the last. |
| POST | `/api/v1/auth/password/reset` | Carries a password and a one-time token. |
| POST | `/api/v1/auth/register` | Carries a password; registering twice mails the same link again. |
| POST | `/api/v1/auth/verify` | A one-time token, spent by the first call. |
| POST | `/api/v1/connections` | Carries a token, and answers a single-use authorization — neither may be stored for replay. |
| POST | `/api/v1/connections/:connectionId/refresh` | Listing again changes nothing but the list. |
| POST | `/api/v1/me/password` | Carries a password. |
| POST | `/api/v1/memory/:memoryId/approve` | Approving an approved memory changes nothing. |
| POST | `/api/v1/memory/:memoryId/forget` | Forgetting a forgotten memory revokes nothing more. |
| POST | `/api/v1/memory/:memoryId/keep` | Keeping a memory twice keeps it once. |
| POST | `/api/v1/memory/:memoryId/reaffirm` | A reaffirmation is limited to one a day by the service; a repeat is refused, not stored. |
| POST | `/api/v1/memory/revocations` | Withdrawing a source again revokes nothing more. |
| POST | `/api/v1/operator/memory/activate` | Authenticated by the signature itself; activating twice is refused by the lifecycle. |
| POST | `/api/v1/operator/memory/stage` | Authenticated by the signature itself; a repeat stages a second claim the operator sees. |
| POST | `/api/v1/skills/versions/:versionId/approve` | A version is approved once; the database refuses a second move from staging. |
| POST | `/api/v1/skills/versions/:versionId/reject` | A version is rejected once; the database refuses a second move from staging. |
| POST | `/api/v1/skills/versions/:versionId/replay` | A replay is queued once per attempt number; a repeat queues nothing new. |
