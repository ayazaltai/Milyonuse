-- 0009 — tools that change the world, and the connections they reach it through (F3).
--
-- Rule 3: no tool writes. A call that changes something outside the
-- conversation is classified by the RiskEngine (D-11); unless it is safe — or
-- reversible in auto mode — it becomes a proposal a person confirms. What a
-- proposal proposes is fixed when it is made; it runs at most once, as the
-- person who confirmed it, within a day (ported from App-Milyonus 0051,
-- generalised from its fixed kinds to any tool call).
--
-- A connection is a person's: an MCP server or an OAuth app they connected,
-- its secrets encrypted by the API (AES-256-GCM, SECRETS_KEY) before they reach
-- this database, never readable as text here.

-- ────────────────────────────────────────────────────────────── connections
CREATE TYPE connection_status AS ENUM ('active', 'disabled', 'error', 'revoked');

CREATE TABLE connections (
  id              ulid              PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid              NOT NULL,
  member_id       ulid              NOT NULL,
  -- Which app card it was made from: milyonus, gmail, google_calendar, …, or custom.
  provider        text              NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  name            text              NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  transport       text              NOT NULL CHECK (transport IN ('mcp_http', 'oauth_api')),
  server_url      text              CHECK (server_url IS NULL OR (server_url ~ '^https://' AND char_length(server_url) <= 500)),
  status          connection_status NOT NULL DEFAULT 'active',
  scopes          text[]            NOT NULL DEFAULT '{}',
  -- The tools the server offered when last listed, each with the risk we give it.
  tools           jsonb             NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tools) = 'array'),
  account_label   text              CHECK (char_length(account_label) <= 200),
  last_error      text              CHECK (char_length(last_error) <= 1000),
  last_used_at    timestamptz,
  created_at      timestamptz       NOT NULL DEFAULT now(),
  updated_at      timestamptz       NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id) REFERENCES members (organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, member_id, id),
  CONSTRAINT connections_server CHECK ((transport = 'mcp_http') = (server_url IS NOT NULL))
);

CREATE INDEX connections_member_idx ON connections (organization_id, member_id, status);
CREATE UNIQUE INDEX connections_one_per_server ON connections (member_id, provider, server_url)
  WHERE status <> 'revoked';

CREATE TRIGGER connections_updated_at BEFORE UPDATE ON connections
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- A revoked connection stays revoked: reconnecting is a new connection, and
-- what was granted under the old one is not quietly revived.
CREATE OR REPLACE FUNCTION app.guard_connection() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.organization_id, NEW.member_id, NEW.provider, NEW.transport, NEW.server_url, NEW.created_at)
     IS DISTINCT FROM (OLD.organization_id, OLD.member_id, OLD.provider, OLD.transport, OLD.server_url, OLD.created_at) THEN
    RAISE EXCEPTION 'connection %: what it connects to does not change', OLD.id
      USING ERRCODE = 'check_violation', HINT = 'connection_identity_fixed';
  END IF;
  IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN
    RAISE EXCEPTION 'connection % was disconnected; connect again instead', OLD.id
      USING ERRCODE = 'check_violation', HINT = 'connection_revoked';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER connections_guarded BEFORE UPDATE ON connections
  FOR EACH ROW EXECUTE FUNCTION app.guard_connection();

-- The secrets: ciphertext only, and gone the moment the connection is revoked.
CREATE TABLE connection_secrets (
  connection_id   ulid        PRIMARY KEY,
  organization_id ulid        NOT NULL,
  member_id       ulid        NOT NULL,
  key_version     smallint    NOT NULL CHECK (key_version > 0),
  iv              bytea       NOT NULL CHECK (octet_length(iv) = 12),
  tag             bytea       NOT NULL CHECK (octet_length(tag) = 16),
  ciphertext      bytea       NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 65536),
  -- When the access token it holds stops working, so it is refreshed first.
  expires_at      timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id, connection_id)
    REFERENCES connections (organization_id, member_id, id) ON DELETE CASCADE
);

-- SECURITY DEFINER: the application role may not delete secrets itself, only
-- cause it by revoking; row-level security still scopes the delete.
CREATE OR REPLACE FUNCTION app.drop_revoked_connection_secrets() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, app, pg_temp
AS $$
BEGIN
  IF NEW.status = 'revoked' AND OLD.status <> 'revoked' THEN
    DELETE FROM connection_secrets WHERE connection_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER connections_revoked_secrets AFTER UPDATE OF status ON connections
  FOR EACH ROW EXECUTE FUNCTION app.drop_revoked_connection_secrets();

CREATE OR REPLACE FUNCTION app.guard_connection_secret() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM connections c WHERE c.id = NEW.connection_id AND c.status = 'revoked') THEN
    RAISE EXCEPTION 'connection % was disconnected', NEW.connection_id
      USING ERRCODE = 'check_violation', HINT = 'connection_revoked';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER connection_secrets_guarded BEFORE INSERT OR UPDATE ON connection_secrets
  FOR EACH ROW EXECUTE FUNCTION app.guard_connection_secret();

-- An OAuth authorization in flight: its PKCE verifier (encrypted), for ten
-- minutes, used once.
CREATE TABLE connection_oauth_states (
  id              ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid        NOT NULL,
  member_id       ulid        NOT NULL,
  -- sha256 of the `state` parameter; the parameter itself never rests here.
  state_hash      text        NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  provider        text        NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  server_url      text        CHECK (server_url IS NULL OR char_length(server_url) <= 500),
  details         jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  key_version     smallint    NOT NULL CHECK (key_version > 0),
  iv              bytea       NOT NULL CHECK (octet_length(iv) = 12),
  tag             bytea       NOT NULL CHECK (octet_length(tag) = 16),
  ciphertext      bytea       NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 8192),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  used_at         timestamptz,
  FOREIGN KEY (organization_id, member_id) REFERENCES members (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT connection_oauth_states_short CHECK (expires_at <= created_at + interval '10 minutes')
);

CREATE OR REPLACE FUNCTION app.guard_oauth_state() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.state_hash, NEW.ciphertext, NEW.member_id, NEW.provider, NEW.server_url, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.state_hash, OLD.ciphertext, OLD.member_id, OLD.provider, OLD.server_url, OLD.created_at, OLD.expires_at)
     OR OLD.used_at IS NOT NULL OR NEW.used_at IS NULL THEN
    RAISE EXCEPTION 'an authorization is used once'
      USING ERRCODE = 'check_violation', HINT = 'oauth_state_used';
  END IF;
  IF now() >= OLD.expires_at THEN
    RAISE EXCEPTION 'the authorization expired at %', OLD.expires_at
      USING ERRCODE = 'check_violation', HINT = 'oauth_state_expired';
  END IF;
  NEW.used_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER connection_oauth_states_guarded BEFORE UPDATE ON connection_oauth_states
  FOR EACH ROW EXECUTE FUNCTION app.guard_oauth_state();

-- ──────────────────────────────────────────────────────────────── proposals
CREATE TYPE agent_action_status AS ENUM (
  'proposed',   -- shown, waiting for the person
  'running',    -- confirmed; the work is under way
  'completed',  -- done — some items may have failed, each with its reason
  'failed',     -- stopped: nothing more will run
  'discarded',  -- the person said no
  'expired'     -- nobody said anything for a day
);

CREATE TABLE agent_actions (
  id              ulid                PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid                NOT NULL,
  member_id       ulid                NOT NULL,
  conversation_id ulid                NOT NULL,
  -- The tool call that proposed it: the agent's message and the call's own id.
  message_id      ulid,
  tool_call_id    text                CHECK (char_length(tool_call_id) <= 120),
  tool            text                NOT NULL CHECK (tool ~ '^[a-z][a-z0-9_.:-]{0,119}$'),
  connection_id   ulid,
  args            jsonb               NOT NULL CHECK (jsonb_typeof(args) = 'object'),
  preview         jsonb               NOT NULL CHECK (jsonb_typeof(preview) = 'object'),
  risk            text                NOT NULL CHECK (risk IN ('safe', 'caution', 'danger')),
  reversible      boolean             NOT NULL,
  reason          text                NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  item_count      integer             NOT NULL DEFAULT 1 CHECK (item_count BETWEEN 1 AND 10000),
  -- Run as it was made, in auto mode, without a card — still recorded, still undoable.
  auto_confirmed  boolean             NOT NULL DEFAULT false,
  -- An undo is a new proposal: the inverse of the one it names.
  undo_of         ulid,
  status          agent_action_status NOT NULL DEFAULT 'proposed',
  processed       integer             NOT NULL DEFAULT 0,
  succeeded       integer             NOT NULL DEFAULT 0,
  failed          integer             NOT NULL DEFAULT 0,
  uncertain       integer             NOT NULL DEFAULT 0,
  claimed_through integer             NOT NULL DEFAULT 0,
  result          jsonb               CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  error           text                CHECK (char_length(error) <= 2000),
  created_at      timestamptz         NOT NULL DEFAULT now(),
  expires_at      timestamptz         NOT NULL DEFAULT now() + interval '24 hours',
  confirmed_at    timestamptz,
  finished_at     timestamptz,
  updated_at      timestamptz         NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id, conversation_id)
    REFERENCES agent_conversations (organization_id, member_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, member_id, connection_id)
    REFERENCES connections (organization_id, member_id, id) ON DELETE SET NULL (connection_id),
  FOREIGN KEY (undo_of) REFERENCES agent_actions (id) ON DELETE SET NULL,
  UNIQUE (organization_id, member_id, id),
  CONSTRAINT agent_actions_progress CHECK (
    processed >= 0 AND succeeded >= 0 AND failed >= 0 AND uncertain >= 0
    AND succeeded + failed + uncertain <= processed
    AND processed <= claimed_through AND claimed_through <= item_count
  ),
  -- A proposal is an offer for a day, not a standing order.
  CONSTRAINT agent_actions_short_lived
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours'),
  CONSTRAINT agent_actions_confirmed_dated
    CHECK ((status IN ('running', 'completed', 'failed')) = (confirmed_at IS NOT NULL)),
  CONSTRAINT agent_actions_finished_dated
    CHECK ((status IN ('completed', 'failed', 'discarded', 'expired')) = (finished_at IS NOT NULL)),
  CONSTRAINT agent_actions_not_own_undo CHECK (undo_of IS DISTINCT FROM id)
);

CREATE INDEX agent_actions_conversation_idx ON agent_actions (conversation_id, created_at);
CREATE INDEX agent_actions_member_idx ON agent_actions (organization_id, member_id, status, created_at DESC);
CREATE INDEX agent_actions_open_idx ON agent_actions (expires_at) WHERE status = 'proposed';
CREATE INDEX agent_actions_undo_idx ON agent_actions (undo_of) WHERE undo_of IS NOT NULL;

CREATE TRIGGER agent_actions_updated_at BEFORE UPDATE ON agent_actions
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Preview is not confirmation: what a proposal proposes is fixed when it is
-- made; only its fate and its progress move, and only forward. The danger
-- class is never auto-confirmed, whatever the caller says.
CREATE OR REPLACE FUNCTION app.guard_agent_action() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed'
       OR NEW.processed <> 0 OR NEW.succeeded <> 0 OR NEW.failed <> 0 OR NEW.uncertain <> 0 OR NEW.claimed_through <> 0
       OR NEW.result IS NOT NULL OR NEW.confirmed_at IS NOT NULL OR NEW.finished_at IS NOT NULL THEN
      RAISE EXCEPTION 'a proposal is made proposed, with nothing done'
        USING ERRCODE = 'check_violation', HINT = 'agent_action_transition';
    END IF;
    IF NEW.auto_confirmed AND (NEW.risk = 'danger' OR NOT NEW.reversible) THEN
      RAISE EXCEPTION 'an irreversible or danger-class call is never run without a person'
        USING ERRCODE = 'check_violation', HINT = 'agent_action_needs_person';
    END IF;
    NEW.created_at := now();
    IF NEW.expires_at > now() + interval '24 hours' THEN
      RAISE EXCEPTION 'a proposal is an offer for a day from when it is made'
        USING ERRCODE = 'check_violation', HINT = 'agent_action_transition';
    END IF;
    IF NEW.undo_of IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM agent_actions a
          WHERE a.id = NEW.undo_of AND a.member_id = NEW.member_id AND a.status = 'completed') THEN
      RAISE EXCEPTION 'only a completed proposal of one''s own can be undone'
        USING ERRCODE = 'check_violation', HINT = 'agent_action_undo_invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.organization_id, NEW.member_id, NEW.conversation_id, NEW.message_id, NEW.tool_call_id, NEW.tool,
      NEW.args, NEW.preview, NEW.risk, NEW.reversible, NEW.reason, NEW.item_count, NEW.auto_confirmed, NEW.undo_of,
      NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.member_id, OLD.conversation_id, OLD.message_id, OLD.tool_call_id, OLD.tool,
      OLD.args, OLD.preview, OLD.risk, OLD.reversible, OLD.reason, OLD.item_count, OLD.auto_confirmed, OLD.undo_of,
      OLD.created_at, OLD.expires_at)
     -- A connection disconnected after the proposal was made leaves it pointing nowhere; that may happen.
     OR (NEW.connection_id IS NOT NULL AND NEW.connection_id IS DISTINCT FROM OLD.connection_id) THEN
    RAISE EXCEPTION 'what a proposal proposes does not change once it is made'
      USING ERRCODE = 'check_violation', HINT = 'agent_action_immutable';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'proposed' AND NEW.status = 'running' THEN
      IF now() >= OLD.expires_at THEN
        RAISE EXCEPTION 'the proposal expired at %', OLD.expires_at
          USING ERRCODE = 'check_violation', HINT = 'agent_action_expired';
      END IF;
      NEW.confirmed_at := now();
    ELSIF OLD.status = 'proposed' AND NEW.status = 'discarded' THEN
      NEW.finished_at := now();
    ELSIF OLD.status = 'proposed' AND NEW.status = 'expired' THEN
      IF now() < OLD.expires_at THEN
        RAISE EXCEPTION 'the proposal has not expired yet'
          USING ERRCODE = 'check_violation', HINT = 'agent_action_transition';
      END IF;
      NEW.finished_at := now();
    ELSIF OLD.status = 'running' AND NEW.status IN ('completed', 'failed') THEN
      NEW.finished_at := now();
    ELSE
      RAISE EXCEPTION 'a proposal cannot go from % to %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation', HINT = 'agent_action_transition';
    END IF;
    RETURN NEW;
  END IF;

  -- Progress moves only while the work runs, and only forward.
  IF (NEW.processed, NEW.succeeded, NEW.failed, NEW.uncertain, NEW.claimed_through, NEW.result, NEW.error,
      NEW.confirmed_at, NEW.finished_at)
     IS DISTINCT FROM
     (OLD.processed, OLD.succeeded, OLD.failed, OLD.uncertain, OLD.claimed_through, OLD.result, OLD.error,
      OLD.confirmed_at, OLD.finished_at) THEN
    IF OLD.status <> 'running'
       OR NEW.processed < OLD.processed OR NEW.succeeded < OLD.succeeded OR NEW.failed < OLD.failed
       OR NEW.uncertain < OLD.uncertain OR NEW.claimed_through < OLD.claimed_through
       OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       OR NEW.finished_at IS DISTINCT FROM OLD.finished_at THEN
      RAISE EXCEPTION 'a proposal''s progress moves only forward, and only while it runs'
        USING ERRCODE = 'check_violation', HINT = 'agent_action_transition';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_actions_guarded BEFORE INSERT OR UPDATE ON agent_actions
  FOR EACH ROW EXECUTE FUNCTION app.guard_agent_action();

-- The pieces of a large proposal, run slice by slice in the durable queue. An
-- item claimed and never finished — the process died with it — is uncertain:
-- reported, never run a second time.
CREATE TYPE agent_action_item_status AS ENUM ('pending', 'running', 'succeeded', 'failed', 'uncertain');

CREATE TABLE agent_action_items (
  action_id       ulid                     NOT NULL,
  seq             integer                  NOT NULL CHECK (seq >= 1),
  organization_id ulid                     NOT NULL,
  member_id       ulid                     NOT NULL,
  input           jsonb                    NOT NULL,
  status          agent_action_item_status NOT NULL DEFAULT 'pending',
  result          jsonb,
  error           text                     CHECK (char_length(error) <= 1000),
  started_at      timestamptz,
  finished_at     timestamptz,
  PRIMARY KEY (action_id, seq),
  FOREIGN KEY (organization_id, member_id, action_id)
    REFERENCES agent_actions (organization_id, member_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_action_items_started CHECK ((status = 'pending') = (started_at IS NULL)),
  CONSTRAINT agent_action_items_finished CHECK ((status IN ('succeeded', 'failed', 'uncertain')) = (finished_at IS NOT NULL))
);

CREATE INDEX agent_action_items_open_idx ON agent_action_items (action_id, seq) WHERE status IN ('pending', 'running');

CREATE OR REPLACE FUNCTION app.guard_agent_action_item() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.action_id, NEW.seq, NEW.organization_id, NEW.member_id, NEW.input)
     IS DISTINCT FROM (OLD.action_id, OLD.seq, OLD.organization_id, OLD.member_id, OLD.input) THEN
    RAISE EXCEPTION 'an item''s input does not change'
      USING ERRCODE = 'check_violation', HINT = 'agent_action_immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'pending' AND NEW.status = 'running' THEN
      NEW.started_at := now();
    ELSIF OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed', 'uncertain') THEN
      NEW.finished_at := now();
    ELSE
      -- Above all: never from uncertain or running back to pending — that would run it twice.
      RAISE EXCEPTION 'an item cannot go from % to %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation', HINT = 'agent_action_item_once';
    END IF;
  ELSIF OLD.status IN ('succeeded', 'failed', 'uncertain') THEN
    RAISE EXCEPTION 'a finished item does not change'
      USING ERRCODE = 'check_violation', HINT = 'agent_action_item_once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_action_items_guarded BEFORE UPDATE ON agent_action_items
  FOR EACH ROW EXECUTE FUNCTION app.guard_agent_action_item();

-- ─────────────────────────────────────────────────────────────── sandbox
CREATE TABLE sandbox_sessions (
  id              ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid        NOT NULL,
  member_id       ulid        NOT NULL,
  conversation_id ulid,
  action_id       ulid,
  provider        text        NOT NULL CHECK (provider IN ('vercel', 'local')),
  external_id     text        CHECK (char_length(external_id) <= 200),
  runtime         text        NOT NULL CHECK (runtime IN ('python', 'node')),
  status          text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'timed_out')),
  exit_code       integer,
  duration_ms     integer     CHECK (duration_ms >= 0),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  FOREIGN KEY (organization_id, member_id) REFERENCES members (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT sandbox_sessions_finished CHECK ((status = 'running') = (finished_at IS NULL))
);

CREATE INDEX sandbox_sessions_member_day_idx ON sandbox_sessions (organization_id, member_id, started_at DESC);

CREATE OR REPLACE FUNCTION app.guard_sandbox_session() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'a finished sandbox session is a record'
      USING ERRCODE = 'check_violation', HINT = 'sandbox_session_finished';
  END IF;
  IF NEW.status <> 'running' THEN
    NEW.finished_at := clock_timestamp();
    NEW.duration_ms := GREATEST(0, (extract(epoch FROM clock_timestamp() - OLD.started_at) * 1000)::integer);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sandbox_sessions_guarded BEFORE UPDATE ON sandbox_sessions
  FOR EACH ROW EXECUTE FUNCTION app.guard_sandbox_session();

-- ─────────────────────────────────────────────────────────── files made
-- What the agent writes for the person — a report, a table, a document — kept
-- for a while for them to download. Ours to delete when its time is up.
CREATE TABLE agent_files (
  id              ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid        NOT NULL,
  member_id       ulid        NOT NULL,
  conversation_id ulid        NOT NULL,
  name            text        NOT NULL CHECK (name ~ '^[^/\\\x00-\x1f]{1,120}$'),
  content_type    text        NOT NULL CHECK (content_type ~ '^[a-z]+/[a-z0-9.+-]+$' AND char_length(content_type) <= 120),
  bytes           bytea       NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 10485760),
  size            integer     GENERATED ALWAYS AS (octet_length(bytes)) STORED,
  sha256          text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  source          text        NOT NULL CHECK (source IN ('file_create', 'code_run')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '30 days',
  FOREIGN KEY (organization_id, member_id, conversation_id)
    REFERENCES agent_conversations (organization_id, member_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_files_kept CHECK (expires_at > created_at AND expires_at <= created_at + interval '90 days')
);

CREATE INDEX agent_files_conversation_idx ON agent_files (conversation_id, created_at);
CREATE INDEX agent_files_expiry_idx ON agent_files (expires_at);

-- ──────────────────────────────────────────────────────── row-level security
-- All of it is one person's: the policies name the member as well as the
-- organization, as the conversations they belong to do.
ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE connections FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connections
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

ALTER TABLE connection_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_secrets FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connection_secrets
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

ALTER TABLE connection_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_oauth_states FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connection_oauth_states
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

ALTER TABLE agent_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_actions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_actions
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

ALTER TABLE agent_action_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_action_items FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_action_items
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

ALTER TABLE sandbox_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_sessions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sandbox_sessions
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

ALTER TABLE agent_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_files FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_files
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

-- ───────────────────────────────────────────────────────────────── grants
-- The application role makes and moves proposals, keeps a person's
-- connections and their encrypted secrets, records sandbox runs and the files
-- the agent made. It deletes a connection's secrets only by revoking it. The
-- platform role expires proposals nobody answered and deletes files past their
-- days (the hourly pass).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milyonuse_app') THEN
    REVOKE ALL ON connections, connection_secrets, connection_oauth_states, agent_actions, agent_action_items,
                  sandbox_sessions, agent_files
      FROM milyonuse_app;
    GRANT SELECT, INSERT ON connections TO milyonuse_app;
    GRANT UPDATE (name, status, scopes, tools, account_label, last_error, last_used_at, updated_at) ON connections TO milyonuse_app;
    GRANT SELECT, INSERT ON connection_secrets TO milyonuse_app;
    GRANT UPDATE (key_version, iv, tag, ciphertext, expires_at, updated_at) ON connection_secrets TO milyonuse_app;
    GRANT SELECT, INSERT ON connection_oauth_states TO milyonuse_app;
    GRANT UPDATE (used_at) ON connection_oauth_states TO milyonuse_app;
    GRANT SELECT, INSERT ON agent_actions TO milyonuse_app;
    GRANT UPDATE (connection_id, status, processed, succeeded, failed, uncertain, claimed_through, result, error,
                  confirmed_at, finished_at, updated_at)
      ON agent_actions TO milyonuse_app;
    GRANT SELECT, INSERT ON agent_action_items TO milyonuse_app;
    GRANT UPDATE (status, result, error, started_at, finished_at) ON agent_action_items TO milyonuse_app;
    GRANT SELECT, INSERT ON sandbox_sessions TO milyonuse_app;
    GRANT UPDATE (external_id, status, exit_code, duration_ms, finished_at) ON sandbox_sessions TO milyonuse_app;
    GRANT SELECT, INSERT ON agent_files TO milyonuse_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milyonuse_platform') THEN
    REVOKE ALL ON connections, connection_secrets, connection_oauth_states, agent_actions, agent_action_items,
                  sandbox_sessions, agent_files
      FROM milyonuse_platform;
    GRANT SELECT ON agent_actions, connections, sandbox_sessions TO milyonuse_platform;
    GRANT UPDATE (status, finished_at, updated_at) ON agent_actions TO milyonuse_platform;
    GRANT SELECT, DELETE ON agent_files, connection_oauth_states TO milyonuse_platform;
  END IF;
END $$;

-- The secrets' delete is the schema owner's alone; the default grants of 0001 are taken back.
DO $$
DECLARE
  role text;
BEGIN
  FOREACH role IN ARRAY ARRAY['PUBLIC', 'milyonuse_app', 'milyonuse_platform'] LOOP
    IF role = 'PUBLIC' OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.drop_revoked_connection_secrets() FROM %s', role);
    END IF;
  END LOOP;
END $$;
