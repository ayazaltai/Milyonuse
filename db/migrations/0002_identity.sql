-- 0002_identity
-- People, the organizations they work in, and how they prove who they are.
--
-- Milyonuse is a consumer product (DECISIONS D-02): whoever registers gets a
-- personal organization, and that organization is the tenant every later
-- table is isolated by. A shared organization — a family, a small team — is
-- the same table with kind = 'shared' and more than one member (Phase 9).

CREATE TYPE organization_kind   AS ENUM ('personal', 'shared');
CREATE TYPE organization_status AS ENUM ('active', 'suspended', 'closed');
CREATE TYPE member_role         AS ENUM ('owner', 'admin', 'member');
CREATE TYPE member_status       AS ENUM ('active', 'deactivated');

-- ──────────────────────────────────────────────────────────────────── users
-- One person, one login. Global by nature — the same person can belong to
-- several organizations — but not readable globally: a request sees the people
-- who share its organization and nobody else (policy below).
CREATE TABLE users (
  id                 ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  email              citext      NOT NULL UNIQUE
                     CONSTRAINT users_email_shape CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
  name               text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  locale             text        NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'tr')),
  time_zone          text        NOT NULL DEFAULT 'UTC' CHECK (length(time_zone) BETWEEN 1 AND 64),
  email_verified_at  timestamptz,
  terms_accepted_at  timestamptz,
  last_seen_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- A time zone is an IANA name Postgres knows, or every scheduled run computed
-- in it later (Phase 6) is computed in UTC without anyone noticing.
CREATE OR REPLACE FUNCTION app.assert_time_zone() RETURNS trigger
  LANGUAGE plpgsql STABLE
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.time_zone) THEN
    RAISE EXCEPTION 'unknown time zone %', NEW.time_zone
      USING ERRCODE = 'check_violation', HINT = 'time_zone_unknown';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_time_zone BEFORE INSERT OR UPDATE OF time_zone ON users
  FOR EACH ROW EXECUTE FUNCTION app.assert_time_zone();

-- ──────────────────────────────────────────────────────────── organizations
CREATE TABLE organizations (
  id             ulid                PRIMARY KEY DEFAULT app.generate_ulid(),
  name           text                NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  kind           organization_kind   NOT NULL,
  status         organization_status NOT NULL DEFAULT 'active',
  -- Who opened it. For a personal organization, also the only person it may
  -- ever have (app.assert_personal_membership).
  owner_user_id  ulid                NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at     timestamptz         NOT NULL DEFAULT now(),
  updated_at     timestamptz         NOT NULL DEFAULT now()
);

-- One personal organization per person: a second one would split their agents,
-- memory and history in two with no way to say which is "theirs".
CREATE UNIQUE INDEX organizations_one_personal
  ON organizations (owner_user_id) WHERE kind = 'personal';

CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- What an organization is does not change after it opens.
CREATE OR REPLACE FUNCTION app.protect_organization_identity() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.kind <> OLD.kind OR NEW.owner_user_id <> OLD.owner_user_id THEN
    RAISE EXCEPTION 'an organization''s kind and opener are fixed'
      USING ERRCODE = 'check_violation', HINT = 'organization_identity_fixed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER organizations_identity_fixed BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION app.protect_organization_identity();

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations
  USING (id = (SELECT app.current_organization_id()));

-- ──────────────────────────────────────────────────────────────────── members
CREATE TABLE members (
  id               ulid          PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id  ulid          NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id          ulid          NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role             member_role   NOT NULL DEFAULT 'member',
  status           member_status NOT NULL DEFAULT 'active',
  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now(),
  deactivated_at   timestamptz,
  UNIQUE (organization_id, user_id),
  -- Targets for composite foreign keys: a row elsewhere that names a member
  -- names it together with its organization (and, for sessions, its person),
  -- so a reference can never cross a tenant. Foreign keys are checked without
  -- row-level security; these make the check itself tenant-aware.
  UNIQUE (organization_id, id),
  UNIQUE (id, user_id),
  CONSTRAINT members_deactivation CHECK ((status = 'deactivated') = (deactivated_at IS NOT NULL))
);

CREATE INDEX members_user_idx ON members (user_id);

CREATE TRIGGER members_updated_at BEFORE UPDATE ON members
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE members FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON members
  USING (organization_id = (SELECT app.current_organization_id()));

-- A personal organization has exactly one member: the person who opened it,
-- as its owner.
CREATE OR REPLACE FUNCTION app.assert_personal_membership() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  org organizations%ROWTYPE;
BEGIN
  SELECT * INTO org FROM organizations WHERE id = NEW.organization_id;
  IF org.kind = 'personal' AND (NEW.user_id <> org.owner_user_id OR NEW.role <> 'owner') THEN
    RAISE EXCEPTION 'a personal organization belongs to its owner alone'
      USING ERRCODE = 'check_violation', HINT = 'personal_organization_single_member';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER members_personal BEFORE INSERT OR UPDATE OF user_id, role, organization_id ON members
  FOR EACH ROW EXECUTE FUNCTION app.assert_personal_membership();

-- An organization always keeps an active owner. Without this, a mis-ordered
-- change leaves a tenant nobody can administer. A cascade from the
-- organization itself being removed is let through: its absence is the
-- signal that this is a teardown, not an offboarding.
CREATE OR REPLACE FUNCTION app.protect_last_owner() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  remaining integer;
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = OLD.organization_id) THEN
    RETURN OLD;
  END IF;

  IF OLD.role <> 'owner' OR OLD.status <> 'active' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.role = 'owner' AND NEW.status = 'active' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO remaining
  FROM members m
  WHERE m.organization_id = OLD.organization_id
    AND m.role = 'owner'
    AND m.status = 'active'
    AND m.id <> OLD.id;

  IF remaining = 0 THEN
    RAISE EXCEPTION 'organization % would be left without an active owner', OLD.organization_id
      USING ERRCODE = 'check_violation', HINT = 'last_owner_protected';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER members_protect_last_owner BEFORE UPDATE OR DELETE ON members
  FOR EACH ROW EXECUTE FUNCTION app.protect_last_owner();

-- users, readable to the people one shares an organization with. Written only
-- by the platform role (registration, sign-in) and by a person editing their
-- own profile, which the API does in their own organization's scope.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users
  USING (EXISTS (
    SELECT 1 FROM members m
    WHERE m.user_id = users.id
      AND m.organization_id = (SELECT app.current_organization_id())
  ));

-- ─────────────────────────────────────────────────────────── user_credentials
-- One password per person, stored as a scrypt digest that names its own
-- parameters: scrypt$<log2 N>$<r>$<p>$<salt>$<key>, salt and key base64url.
-- Anything else — a password in the clear, another scheme — is refused here,
-- whoever writes it. A table of its own so the digest is never on the way of a
-- customer request: only the platform role can read it.
CREATE TABLE user_credentials (
  user_id             ulid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  password_hash       text        NOT NULL,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_credentials_scrypt CHECK (
    password_hash ~ '^scrypt\$[0-9]{1,2}\$[0-9]{1,2}\$[0-9]{1,2}\$[A-Za-z0-9_-]{16,}\$[A-Za-z0-9_-]{32,}$'
  )
);

CREATE TRIGGER user_credentials_updated_at BEFORE UPDATE ON user_credentials
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ──────────────────────────────────────────────────────────── account_tokens
-- The links an account mail carries.
--
--   verify_email   a registration waiting for its address to be confirmed. It
--                  holds what the person typed — name, language, time zone and
--                  the digest of their password — so nothing exists under an
--                  address until someone who reads its inbox says so.
--   set_password   a password link, mailed on request.
--
-- Only the SHA-256 of the token is kept; the token itself exists in the mail.
-- One open link per address and purpose — asking again replaces the last —
-- and redeeming deletes it, so a double click cannot open two accounts.
CREATE TYPE account_token_purpose AS ENUM ('verify_email', 'set_password');

CREATE TABLE account_tokens (
  id          ulid                  PRIMARY KEY DEFAULT app.generate_ulid(),
  purpose     account_token_purpose NOT NULL,
  email       citext                NOT NULL,
  user_id     ulid                  REFERENCES users (id) ON DELETE CASCADE,
  token_hash  text                  NOT NULL UNIQUE,
  payload     jsonb,
  issued_at   timestamptz           NOT NULL DEFAULT now(),
  expires_at  timestamptz           NOT NULL,
  CONSTRAINT account_tokens_one_open UNIQUE (purpose, email),
  CONSTRAINT account_tokens_digest CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- A link is a sign-in in waiting, not a standing credential.
  CONSTRAINT account_tokens_short_lived CHECK (
    expires_at > issued_at
    AND expires_at <= issued_at + CASE purpose
                                    WHEN 'verify_email' THEN interval '48 hours'
                                    ELSE interval '2 hours'
                                  END
  ),
  CONSTRAINT account_tokens_registration CHECK (
    purpose <> 'verify_email'
    OR (payload ->> 'passwordHash') ~ '^scrypt\$[0-9]{1,2}\$[0-9]{1,2}\$[0-9]{1,2}\$[A-Za-z0-9_-]{16,}\$[A-Za-z0-9_-]{32,}$'
  ),
  -- What waits for confirmation is a digest. The password itself is never a
  -- value in this table, under any key.
  CONSTRAINT account_tokens_no_password CHECK (payload IS NULL OR NOT payload ? 'password'),
  CONSTRAINT account_tokens_password_link CHECK (purpose <> 'set_password' OR user_id IS NOT NULL)
);

CREATE INDEX account_tokens_expiry_idx ON account_tokens (expires_at);
CREATE INDEX account_tokens_user_idx ON account_tokens (user_id) WHERE user_id IS NOT NULL;

-- Both tables belong to the platform role only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milyonuse_app') THEN
    REVOKE ALL ON user_credentials, account_tokens FROM milyonuse_app;
  END IF;
END $$;
