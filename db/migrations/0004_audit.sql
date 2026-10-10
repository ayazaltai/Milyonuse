-- 0004_audit
-- Append-only record of who changed what, in each organization.
--
-- Append-only is enforced, not assumed: UPDATE and DELETE are revoked from the
-- application role and a trigger refuses them for everyone else. An audit
-- trail the application can rewrite answers nothing.
--
-- From Phase 1 on, agents act on a person's behalf; actor_type 'agent' names
-- those entries, with the run that produced them in `after`.

CREATE TYPE actor_type AS ENUM ('member', 'agent', 'system');

CREATE TABLE audit_log (
  id              ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  -- NULL when the actor is not a member: a scheduled pass, say. A plain
  -- column: a member removed later must not take their history with them.
  actor_member_id ulid,
  actor_type      actor_type  NOT NULL DEFAULT 'member',
  action          text        NOT NULL CHECK (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$' AND length(action) <= 80),
  resource_type   text        NOT NULL CHECK (resource_type ~ '^[a-z][a-z_]*$' AND length(resource_type) <= 40),
  resource_id     text        CHECK (length(resource_id) <= 64),
  before          jsonb,
  after           jsonb,
  ip              inet,
  user_agent      text        CHECK (length(user_agent) <= 512),
  request_id      text        CHECK (length(request_id) <= 128),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_member_actor CHECK (actor_type <> 'member' OR actor_member_id IS NOT NULL)
);

CREATE INDEX audit_log_org_time_idx ON audit_log (organization_id, created_at DESC);
CREATE INDEX audit_log_resource_idx ON audit_log (organization_id, resource_type, resource_id);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING (organization_id = (SELECT app.current_organization_id()));

CREATE OR REPLACE FUNCTION app.reject_audit_mutation() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  -- Closing an account, and honouring an erasure request, both remain
  -- possible: a cascade from a removed organization is let through. The
  -- application role has no DELETE right here at all, so this is not a way in.
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = OLD.organization_id) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'audit_log is append-only (attempted %)', TG_OP
    USING ERRCODE = 'insufficient_privilege', HINT = 'audit_log_immutable';
END;
$$;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milyonuse_app') THEN
    REVOKE UPDATE, DELETE ON audit_log FROM milyonuse_app;
  END IF;
END $$;
