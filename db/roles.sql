-- Cluster roles. Run once per environment, before migrations.
--
-- Three roles, because "who is connecting" is what makes row-level security
-- real:
--
--   milyonuse           owns the schema and runs migrations. Subject to RLS
--                       (every tenant table is FORCEd), so it cannot read
--                       tenant data by accident either.
--   milyonuse_app       what the API connects as. Always inside a tenant scope.
--   milyonuse_platform  BYPASSRLS. Only for work that runs before a tenant is
--                       known: registration, resolving a session cookie, rate
--                       limits, the queue's bookkeeping. Grep for PLATFORM_POOL
--                       to audit every such path.
--
-- Passwords here are local defaults. Real environments take them from the
-- secret manager.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milyonuse') THEN
    CREATE ROLE milyonuse LOGIN PASSWORD 'milyonuse' CREATEDB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milyonuse_app') THEN
    CREATE ROLE milyonuse_app LOGIN PASSWORD 'milyonuse';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milyonuse_platform') THEN
    CREATE ROLE milyonuse_platform LOGIN PASSWORD 'milyonuse' BYPASSRLS;
  END IF;
END $$;
