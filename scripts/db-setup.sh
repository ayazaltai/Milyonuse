#!/usr/bin/env bash
# Local database setup: the three roles, the database, then the migrations.
#
# Runs roles.sql and database.sql as the cluster's bootstrap superuser
# (DATABASE_URL_SUPERUSER), then migrates as the schema owner. Safe to run
# again: roles are created if missing, the database only when absent, and the
# migration runner applies only what is new.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SUPERUSER_URL="${DATABASE_URL_SUPERUSER:-postgres://postgres:postgres@127.0.0.1:5432/postgres}"

psql "$SUPERUSER_URL" -v ON_ERROR_STOP=1 -q -f db/roles.sql
if [ "$(psql "$SUPERUSER_URL" -tAc "SELECT 1 FROM pg_database WHERE datname = 'milyonuse'")" != "1" ]; then
  psql "$SUPERUSER_URL" -v ON_ERROR_STOP=1 -q -f db/database.sql
  echo "database milyonuse created"
fi

# The owner and the app role must be bound by row-level security; a superuser
# or BYPASSRLS role would make every isolation test meaningless.
psql "$SUPERUSER_URL" -v ON_ERROR_STOP=1 -qc "DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('milyonuse', 'milyonuse_app') AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'milyonuse and milyonuse_app must not bypass row-level security'; END IF; END \$\$"

DATABASE_URL_MIGRATOR="${DATABASE_URL_MIGRATOR:-postgres://milyonuse:milyonuse@127.0.0.1:5432/milyonuse}" \
  pnpm --filter @milyonuse/db migrate
