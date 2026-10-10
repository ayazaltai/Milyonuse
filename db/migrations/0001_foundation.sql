-- 0001_foundation
-- The primitives every later migration builds on:
--   * extensions
--   * a ULID domain for every primary key, and its server-side generator
--   * the tenant-context functions that row-level policies read
--   * the updated_at trigger helper
--   * privileges for both application roles, maintained here rather than by
--     hand, so a table added later is never one the API cannot read
--
-- No domain tables here.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- Created by the superuser in db/database.sql on a self-managed cluster, where
-- it is not a trusted extension; on Neon the owner may create it.
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------- identifiers
-- ULIDs: sortable by creation time, and they do not leak tenant counts the way
-- a bigint sequence does. 130 bits of Crockford base32 for 128 bits of value,
-- so the leading character is always 0-7.
CREATE DOMAIN ulid AS char(26)
  CONSTRAINT ulid_format CHECK (VALUE ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$');

CREATE SCHEMA IF NOT EXISTS app;

-- Application code may generate its own ids; this exists for the places that
-- cannot — trigger bodies, backfills, an operator inserting a row by hand — so
-- those rows cannot end up in a different format from the rest of the table.
CREATE OR REPLACE FUNCTION app.generate_ulid() RETURNS ulid
  LANGUAGE plpgsql VOLATILE
AS $fn$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  ms       bigint  := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  bits     bit(130);
  result   text := '';
  i        integer;
BEGIN
  -- gen_random_bytes rather than random(): ids appear in URLs and audit
  -- records, and a predictable generator there is a needless liability.
  bits := B'00'
        || substring(ms::bit(64) from 17 for 48)
        || ('x' || encode(gen_random_bytes(10), 'hex'))::bit(80);

  FOR i IN 0..25 LOOP
    result := result || substr(alphabet, substring(bits from i * 5 + 1 for 5)::integer + 1, 1);
  END LOOP;

  RETURN result;
END;
$fn$;

COMMENT ON FUNCTION app.generate_ulid() IS
  'ULID: 48-bit ms timestamp + 80 random bits, Crockford base32, sortable by creation time.';

-- ------------------------------------------------------------- tenant context
-- Every request opens its transaction with
--     SELECT set_config('app.organization_id', '<ulid>', true);
-- and policies read it back through this function. Unset, it returns NULL, and
-- a policy comparing against NULL matches nothing — so a forgotten scope fails
-- closed rather than exposing every tenant.
--
-- Policies call it as (SELECT app.current_organization_id()): the sub-select is
-- evaluated once per statement instead of once per row.
CREATE OR REPLACE FUNCTION app.current_organization_id() RETURNS ulid
  LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.organization_id', true), '')::ulid
$$;

COMMENT ON FUNCTION app.current_organization_id() IS
  'Tenant in scope for the current transaction. NULL when unset, so RLS fails closed.';

-- The member acting in the current transaction, when the API knows one. Not a
-- tenant boundary — that is the organization — but the narrower rule some
-- tables add inside a shared organization: a person's own conversations, say.
CREATE OR REPLACE FUNCTION app.current_member_id() RETURNS ulid
  LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.member_id', true), '')::ulid
$$;

-- ------------------------------------------------------------------- triggers
CREATE OR REPLACE FUNCTION app.set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------- privileges
-- Both application roles get the ordinary table rights, now and for every
-- table this owner creates later. A table one of them must not touch revokes
-- it in the migration that creates the table.
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['milyonuse_app', 'milyonuse_platform'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target) THEN
      CONTINUE;
    END IF;
    EXECUTE format('GRANT USAGE ON SCHEMA public, app TO %I', target);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', target);
    EXECUTE format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO %I', target);
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO %I', target);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', target);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO %I', target);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT EXECUTE ON FUNCTIONS TO %I', target);
  END LOOP;
END $$;
