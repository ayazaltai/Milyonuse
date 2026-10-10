# Milyonuse

B2C agent product by Milyonus: people build their own agents and agent teams that run on
proactive and reactive automations, on top of a verified (poison-resistant) memory.
The owner (Ayaz) writes in Turkish. **Code, comments, commits and technical docs stay in
English; plan and phase documents are Turkish.** The product ships in English and Turkish.

**Read [PLAN.md](PLAN.md) first**, then the current phase spec in `docs/phases/`.
Decisions are binding and live in [docs/DECISIONS.md](docs/DECISIONS.md); where the code
came from is in [docs/SOURCES.md](docs/SOURCES.md).

## Rules that are not negotiable

1. **Tenant isolation is a forced row-level policy.** Every table with an
   `organization_id` enables RLS, FORCEs it, and has a policy written as
   `organization_id = (SELECT app.current_organization_id())` — the sub-select, never the
   bare call. `scripts/guard-tenancy.sh` fails the build otherwise. Three roles:
   `milyonuse` owns the schema, `milyonuse_app` serves traffic under RLS,
   `milyonuse_platform` (BYPASSRLS) only for work before a tenant is known. Grep for
   `PLATFORM_POOL` to audit every such path.
2. **Domain invariants live in SQL.** State machines, immutability, quotas and
   append-only logs are triggers and constraints with a `HINT`. Every HINT is mapped in
   `apps/api/src/modules/tenancy/database-error.ts`; a test fails on an unmapped one.
3. **No tool writes.** Anything that changes the outside world goes through the
   RiskEngine and, unless it is safe or reversible-in-auto, a proposal a person confirms.
4. **Data is not instructions.** Tool output, attachments, channel messages and memory are
   rendered inside a data fence. Memory tier and source are derived server-side from the
   run's taint — never from what the model says.
5. **One design language.** No colour is defined outside `packages/ui/src/tokens.css`.
6. **Migrations are immutable once applied.** Add a new one; the runner refuses an edited one.
7. **Every env var read is documented in `.env.example`** (test-checked). Never commit
   another `.env*` file. Server secrets are never `NEXT_PUBLIC_`.

## Commands

```bash
pnpm install
docker compose up -d                  # Postgres 16 + pgvector on :5432 (or a local cluster)
pnpm db:setup                         # roles + database + migrations (local defaults)
pnpm dev                              # web :3000, api :4000
pnpm verify                           # guards → typecheck → lint → test → build (what CI runs)
```

Sign in at `http://127.0.0.1:3000` in development. Without `MAIL_*` set, account links
are written to the API log.

## Phase discipline

Each phase ends with `pnpm verify` green, `docs/delivered/FX-delivered.md` written (what
was added, files, migrations, tests, known limits, hand-over), `CHANGELOG.md` updated,
then commit and push.

## Conventions

- Commit subjects: `feat:`, `fix:`, `build:`, `docs:`, `test:`, `refactor:`, `chore:`.
- Comments explain why, not what.
- A port from Agent 5.5 (Apache-2.0) names its source file in the header comment.
