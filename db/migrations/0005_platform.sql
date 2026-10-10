-- 0005_platform
-- The machinery under every request and every background pass:
--   rate_limit_windows   counters every instance agrees on
--   idempotency_keys     a retried request answered once
--   jobs                 the durable queue — claim, lease, retry
--   system_log           what went wrong, kept where the team can read it
--   worker_heartbeats    when each scheduled pass last finished

-- ───────────────────────────────────────────────────────── rate_limit_windows
-- Fixed windows, one row per key and window, counted by a single upsert.
-- UNLOGGED: a counter is worth nothing after a crash but a window that starts
-- over early, and skipping the write-ahead log makes a hit on every request
-- cheap. Keys are SHA-256 digests — an address is personal data and does not
-- need to be stored to be counted.
CREATE UNLOGGED TABLE rate_limit_windows (
  key          char(64)    NOT NULL CHECK (key ~ '^[0-9a-f]{64}$'),
  window_start timestamptz NOT NULL,
  hits         integer     NOT NULL CHECK (hits > 0),
  PRIMARY KEY (key, window_start)
);

CREATE INDEX rate_limit_windows_start_idx ON rate_limit_windows (window_start);

-- ─────────────────────────────────────────────────────────── idempotency_keys
-- A client sends a request, loses the answer, sends it again. With a key the
-- second request gets the first one's answer and nothing runs twice. A key
-- belongs to one member; only a success is recorded, so a refusal releases it.
CREATE TABLE idempotency_keys (
  organization_id  ulid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  member_id        ulid        NOT NULL,
  key              text        NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  -- What the key was first used for — method, route, parameters and body,
  -- digested. The same key on a different request is a client bug, refused.
  request_hash     text        NOT NULL,
  completed_at     timestamptz,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (organization_id, member_id, key),
  FOREIGN KEY (organization_id, member_id) REFERENCES members (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT idempotency_keys_short_lived CHECK (expires_at <= created_at + interval '24 hours')
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- A replay must return exactly what happened the first time: a record is
-- answered once, then fixed.
CREATE OR REPLACE FUNCTION app.protect_idempotency_key() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.completed_at IS NOT NULL
     OR NEW.completed_at IS NULL
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.member_id       <> OLD.member_id
     OR NEW.key             <> OLD.key
     OR NEW.request_hash    <> OLD.request_hash
     OR NEW.created_at      <> OLD.created_at
     OR NEW.expires_at      <> OLD.expires_at THEN
    RAISE EXCEPTION 'an idempotency record is answered once and then fixed'
      USING ERRCODE = 'insufficient_privilege', HINT = 'idempotency_record_fixed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER idempotency_keys_fixed BEFORE UPDATE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION app.protect_idempotency_key();

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_keys
  USING (organization_id = (SELECT app.current_organization_id()));

-- ─────────────────────────────────────────────────────────────────────── jobs
-- The durable queue. A job is a row: a deploy, a crash or a scale-down leaves
-- the work where it was and the next process picks it up. Kinds are registered
-- in code by the module that owns the work; the queue knows nothing about them
-- beyond their name.
CREATE TYPE job_status AS ENUM ('queued', 'running', 'succeeded', 'skipped', 'failed', 'cancelled');

CREATE TABLE jobs (
  id               ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id  ulid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  kind             text        NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*$' AND length(kind) <= 60),
  status           job_status  NOT NULL DEFAULT 'queued',
  payload          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- The same piece of work has the same key, and a second enqueue of it is a
  -- no-op.
  dedupe_key       text        NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  run_at           timestamptz NOT NULL DEFAULT now(),
  attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts     integer     NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  lease_expires_at timestamptz,
  last_error       text        CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_lease    CHECK ((status = 'running') = (lease_expires_at IS NOT NULL)),
  CONSTRAINT jobs_finished CHECK ((status IN ('succeeded', 'skipped', 'failed', 'cancelled'))
                                  = (finished_at IS NOT NULL))
);

CREATE UNIQUE INDEX jobs_dedupe ON jobs (organization_id, dedupe_key);
CREATE INDEX jobs_queue_idx ON jobs (run_at) WHERE status = 'queued';
CREATE INDEX jobs_lease_idx ON jobs (lease_expires_at) WHERE status = 'running';
CREATE INDEX jobs_finished_idx ON jobs (finished_at) WHERE finished_at IS NOT NULL;

CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- A finished job stays finished: a retry is a new attempt of a queued job,
-- never the resurrection of a done one.
CREATE OR REPLACE FUNCTION app.protect_finished_job() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.finished_at IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'job % already finished as %', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', HINT = 'job_finished';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER jobs_finished_fixed BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION app.protect_finished_job();

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON jobs
  USING (organization_id = (SELECT app.current_organization_id()));

-- ───────────────────────────────────────────────────────────────── system_log
-- Warnings and errors from the API and its workers, masked for personal data
-- and secrets before they leave the process. Not the audit log: that is the
-- tenant's record of who did what; this is the team's record of what the
-- software did, across tenants, and no tenant can read it.
CREATE TABLE system_log (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  level           text        NOT NULL CHECK (level IN ('warn', 'error')),
  msg             text        NOT NULL CHECK (length(msg) BETWEEN 1 AND 500),
  request_id      text        CHECK (length(request_id) <= 128),
  method          text        CHECK (length(method) <= 10),
  path            text        CHECK (length(path) <= 300),
  status          smallint    CHECK (status BETWEEN 100 AND 599),
  organization_id ulid,
  context         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  alerted_at      timestamptz
);

CREATE INDEX system_log_at_idx     ON system_log (at DESC);
CREATE INDEX system_log_unsent_idx ON system_log (id) WHERE level = 'error' AND alerted_at IS NULL;

CREATE OR REPLACE FUNCTION app.protect_system_log() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.at, NEW.level, NEW.msg, NEW.request_id, NEW.method, NEW.path, NEW.status,
      NEW.organization_id, NEW.context)
     IS DISTINCT FROM
     (OLD.id, OLD.at, OLD.level, OLD.msg, OLD.request_id, OLD.method, OLD.path, OLD.status,
      OLD.organization_id, OLD.context) THEN
    RAISE EXCEPTION 'a system log line is written once; only its alert mark may change'
      USING ERRCODE = 'check_violation', HINT = 'system_log_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER system_log_protected BEFORE UPDATE ON system_log
  FOR EACH ROW EXECUTE FUNCTION app.protect_system_log();

-- ────────────────────────────────────────────────────────── worker_heartbeats
CREATE TABLE worker_heartbeats (
  cadence     text        PRIMARY KEY CHECK (cadence IN ('minute', 'quarter-hour', 'hour')),
  finished_at timestamptz NOT NULL,
  -- When this cadence first finished: how long the scheduler has been calling,
  -- so a new deployment's hourly pass is not overdue in its first minute.
  first_finished_at timestamptz NOT NULL DEFAULT now(),
  ok          boolean     NOT NULL,
  -- step → reason, for the steps that failed on the last pass
  failed      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ms          integer     NOT NULL CHECK (ms >= 0)
);

-- Counted, logged and recorded before any tenant is known — the platform
-- role's. The application role may read when the workers last ran (readiness).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milyonuse_app') THEN
    REVOKE ALL ON rate_limit_windows, system_log, worker_heartbeats FROM milyonuse_app;
    GRANT SELECT ON worker_heartbeats TO milyonuse_app;
  END IF;
END $$;
