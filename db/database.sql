-- The database, on a fresh cluster. Run once, as the cluster's bootstrap
-- superuser, after roles.sql and before migrations.
--
-- It belongs to the schema owner, and the schema owner is not a superuser: a
-- superuser bypasses row-level security, FORCE included, so a database owned
-- and migrated by one tests rules that production never relies on.
--
-- pgvector is not a trusted extension, so the superuser creates it here; the
-- other extensions (pgcrypto, citext, pg_trgm) are trusted and are created by
-- the owner in 0001_foundation.sql. On Neon the owner can create all four.

CREATE DATABASE milyonuse OWNER milyonuse;
\connect milyonuse
CREATE EXTENSION IF NOT EXISTS vector;
