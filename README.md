# Milyonuse

Your own AI team — agents and agent teams that run on proactive and reactive
automations, on a memory that verifies before it believes. A product of Milyonus Inc.

- **Plan:** [PLAN.md](PLAN.md) · **Decisions:** [docs/DECISIONS.md](docs/DECISIONS.md) ·
  **Architecture:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · **Sources:** [docs/SOURCES.md](docs/SOURCES.md)
- **Phases:** [docs/phases](docs/phases) · **Delivered:** [docs/delivered](docs/delivered) · [CHANGELOG.md](CHANGELOG.md)
- **API routes:** [docs/api/routes.md](docs/api/routes.md) (generated, test-checked)

## Run it

```bash
pnpm install
cp .env.example .env.local
docker compose up -d          # or a local Postgres 16+ with pgvector
pnpm db:setup                 # roles, database, migrations
pnpm dev                      # web http://127.0.0.1:3000 · api :4000
```

Without mail settings, account links are logged and shown on the page in development.
Without `OPENROUTER_API_KEY`, the agent (`/app/agent`) answers from a rule-based development
stand-in that says so on every answer; set the key for the real model.

## Check it

```bash
pnpm verify                   # guards → typecheck → lint → test → build (what CI runs)
```

## Layout

```
apps/api        NestJS + Fastify — /api/v1
apps/web        Next.js — landing (/en, /tr), sign-in, the app (/app, the agent at /app/agent)
packages/       contracts (zod), ui (design tokens), config
db/             roles, numbered SQL migrations, integration tests
scripts/        guards and setup
docs/           plan, decisions, architecture, phase specs, delivery reports
```
