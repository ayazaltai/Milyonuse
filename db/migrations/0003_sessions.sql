-- 0003_sessions
-- Server-side sessions.
--
-- A self-contained signed token would be simpler, but "sign out everywhere",
-- an idle timeout and ending every session on a password reset all need state
-- the server can change between requests. The cookie holds a random 256-bit
-- token; this table holds only its SHA-256, so a database copy is not a set of
-- usable sessions.

CREATE TABLE sessions (
  id               ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id  ulid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id          ulid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  member_id        ulid        NOT NULL,
  token_hash       text        NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- When credentials were last actually presented, as opposed to when the
  -- session was last used. A sensitive change reads this one.
  authenticated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoked_reason   text        CHECK (revoked_reason IN (
                     'sign_out', 'idle_timeout', 'password_reset', 'password_changed',
                     'revoked_by_user', 'member_deactivated')),
  ip               inet,
  user_agent       text        CHECK (length(user_agent) <= 512),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- The member belongs to this organization and is this person.
  FOREIGN KEY (organization_id, member_id) REFERENCES members (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (member_id, user_id) REFERENCES members (id, user_id) ON DELETE CASCADE,
  CONSTRAINT sessions_lifetime CHECK (expires_at > created_at AND expires_at <= created_at + interval '90 days'),
  CONSTRAINT sessions_revocation CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_member_idx ON sessions (member_id, last_seen_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

-- A session only moves forward: it is seen, and it may end. It never changes
-- whose it is, and an ended session does not come back.
CREATE OR REPLACE FUNCTION app.protect_session() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.organization_id, NEW.user_id, NEW.member_id, NEW.token_hash,
      NEW.authenticated_at, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.user_id, OLD.member_id, OLD.token_hash,
      OLD.authenticated_at, OLD.expires_at, OLD.created_at)
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'a session is seen or ended, nothing else'
      USING ERRCODE = 'check_violation', HINT = 'session_fixed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sessions_fixed BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION app.protect_session();

-- Tenant-scoped so a person can list and end their own sessions. The lookup by
-- token is necessarily different — the tenant is what it determines — and runs
-- on the platform role, by hash, for a single row.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sessions
  USING (organization_id = (SELECT app.current_organization_id()));
