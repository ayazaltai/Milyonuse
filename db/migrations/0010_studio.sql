-- 0010 — the agent studio and skills (F4).
--
-- An agent is a person's own specialist: a name and a face, and a version —
-- persona, instructions, model tier, the tools it may use, what memory it
-- reads, how far it acts on its own, what a run may spend, its skills. A
-- version is a snapshot that never changes; editing an agent is a new
-- version, and every answer records the version that wrote it, so an old
-- answer always shows the agent as it was (acceptance 1).
--
-- A skill is procedural memory (SKILL.md, agentskills.io-compatible). A
-- learned one enters as staging, is scanned, and becomes active only after a
-- replay of the task it came from passes — recorded as evidence in skill_runs
-- — and a person's approval or a trusted policy (acceptance 2). A danger
-- verdict never becomes active. A skill learned from a source is withdrawn
-- with it (acceptance 3).

-- ──────────────────────────────────────────────────────────────── agents
CREATE TABLE agents (
  id                 ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id    ulid        NOT NULL,
  member_id          ulid        NOT NULL,
  name               text        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  avatar             text        NOT NULL DEFAULT '✦' CHECK (char_length(avatar) BETWEEN 1 AND 8),
  role_title         text        NOT NULL DEFAULT '' CHECK (char_length(role_title) <= 80),
  template           text        CHECK (template ~ '^[a-z][a-z0-9-]{1,40}$'),
  current_version_id ulid,
  archived_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id) REFERENCES members (organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, member_id, id)
);

CREATE INDEX agents_member_idx ON agents (organization_id, member_id, archived_at, created_at);

CREATE TRIGGER agents_updated_at BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE agent_versions (
  id                     ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id        ulid        NOT NULL,
  member_id              ulid        NOT NULL,
  agent_id               ulid        NOT NULL,
  version                integer     NOT NULL CHECK (version >= 1),
  persona                text        NOT NULL DEFAULT '' CHECK (char_length(persona) <= 2000),
  instructions           text        NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 8000),
  model_tier             text        NOT NULL DEFAULT 'balanced' CHECK (model_tier IN ('fast', 'balanced', 'deep')),
  -- The tools it may use, by name; a connected app's tools as `connection:<provider>`. Empty: none beyond the core.
  tools                  text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(tools) <= 100),
  memory_scope           text        NOT NULL DEFAULT 'user' CHECK (memory_scope IN ('user', 'agent')),
  autonomy               text        NOT NULL DEFAULT 'ask' CHECK (autonomy IN ('ask', 'auto')),
  unattended_policy      text        NOT NULL DEFAULT 'safe_only' CHECK (unattended_policy IN ('safe_only', 'trusted')),
  budget_tokens          integer     NOT NULL DEFAULT 200000 CHECK (budget_tokens BETWEEN 1000 AND 2000000),
  budget_sandbox_minutes integer     NOT NULL DEFAULT 5 CHECK (budget_sandbox_minutes BETWEEN 0 AND 120),
  -- Skills by id (the person's) — what the agent's prompt lists and may open.
  skills                 ulid[]      NOT NULL DEFAULT '{}' CHECK (cardinality(skills) <= 50),
  note                   text        CHECK (char_length(note) <= 300),
  created_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id, agent_id) REFERENCES agents (organization_id, member_id, id) ON DELETE CASCADE,
  UNIQUE (agent_id, version),
  UNIQUE (organization_id, member_id, id)
);

-- A version is a snapshot: numbered next, by the database, and never changed.
CREATE OR REPLACE FUNCTION app.guard_agent_version() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM agents WHERE id = NEW.agent_id FOR UPDATE;
    NEW.version := COALESCE((SELECT max(version) FROM agent_versions WHERE agent_id = NEW.agent_id), 0) + 1;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'an agent version is a snapshot and does not change (attempted %)', TG_OP
    USING ERRCODE = 'check_violation', HINT = 'agent_version_immutable';
END;
$$;

CREATE TRIGGER agent_versions_insert BEFORE INSERT ON agent_versions
  FOR EACH ROW EXECUTE FUNCTION app.guard_agent_version();
CREATE TRIGGER agent_versions_no_change BEFORE UPDATE OR DELETE ON agent_versions
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION app.guard_agent_version();

ALTER TABLE agents
  ADD CONSTRAINT agents_current_version FOREIGN KEY (organization_id, member_id, current_version_id)
    REFERENCES agent_versions (organization_id, member_id, id) DEFERRABLE INITIALLY DEFERRED;

-- An agent's current version is one of its own.
CREATE OR REPLACE FUNCTION app.guard_agent_current_version() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.current_version_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM agent_versions v WHERE v.id = NEW.current_version_id AND v.agent_id = NEW.id) THEN
    RAISE EXCEPTION 'agent %: its current version must be one of its own', NEW.id
      USING ERRCODE = 'check_violation', HINT = 'agent_version_foreign';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER agents_current_version_own AFTER INSERT OR UPDATE OF current_version_id ON agents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.guard_agent_current_version();

-- A conversation may be with one of the person's agents; each answer names the version that wrote it.
ALTER TABLE agent_conversations ADD COLUMN agent_id ulid;
ALTER TABLE agent_conversations
  ADD CONSTRAINT agent_conversations_agent FOREIGN KEY (organization_id, member_id, agent_id)
    REFERENCES agents (organization_id, member_id, id) ON DELETE SET NULL (agent_id);
ALTER TABLE agent_messages ADD COLUMN agent_version_id ulid REFERENCES agent_versions (id) ON DELETE SET NULL;

-- ──────────────────────────────────────────────────────────────── skills
CREATE TABLE skills (
  id                 ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id    ulid        NOT NULL,
  member_id          ulid        NOT NULL,
  name               text        NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  -- bundled: from the reviewed catalogue · user: written by the person · learned: proposed by an agent.
  source             text        NOT NULL CHECK (source IN ('bundled', 'user', 'learned')),
  enabled            boolean     NOT NULL DEFAULT true,
  current_version_id ulid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id) REFERENCES members (organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, member_id, id),
  UNIQUE (member_id, name)
);

CREATE TRIGGER skills_updated_at BEFORE UPDATE ON skills
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TYPE skill_state AS ENUM ('staging', 'active', 'rejected', 'revoked', 'superseded');

CREATE TABLE skill_versions (
  id                     ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id        ulid        NOT NULL,
  member_id              ulid        NOT NULL,
  skill_id               ulid        NOT NULL,
  version                integer     NOT NULL CHECK (version >= 1),
  state                  skill_state NOT NULL DEFAULT 'staging',
  description            text        NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 500),
  -- The whole SKILL.md: frontmatter and body.
  content                text        NOT NULL CHECK (char_length(content) BETWEEN 1 AND 50000),
  -- Level-2 files beside it: [{path, content}].
  files                  jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(files) = 'array' AND jsonb_array_length(files) <= 10),
  scan_verdict           text        NOT NULL CHECK (scan_verdict IN ('clean', 'caution', 'danger')),
  findings               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- Where a learned skill came from: the turn, its task, and every outside source the turn read.
  source_conversation_id ulid,
  source_run_id          ulid,
  task                   text        CHECK (char_length(task) <= 4000),
  derived_from           text[]      NOT NULL DEFAULT '{}',
  state_reason           text        CHECK (char_length(state_reason) <= 500),
  approved_by            ulid,
  approved_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  decided_at             timestamptz,
  FOREIGN KEY (organization_id, member_id, skill_id) REFERENCES skills (organization_id, member_id, id) ON DELETE CASCADE,
  UNIQUE (skill_id, version),
  UNIQUE (organization_id, member_id, id)
);

CREATE INDEX skill_versions_derived_idx ON skill_versions USING gin (derived_from) WHERE state IN ('staging', 'active');

ALTER TABLE skills
  ADD CONSTRAINT skills_current_version FOREIGN KEY (organization_id, member_id, current_version_id)
    REFERENCES skill_versions (organization_id, member_id, id) DEFERRABLE INITIALLY DEFERRED;

-- The replay gate's evidence: what ran, how it was judged — appended, never changed.
CREATE TABLE skill_runs (
  id               ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id  ulid        NOT NULL,
  member_id        ulid        NOT NULL,
  skill_version_id ulid        NOT NULL,
  kind             text        NOT NULL DEFAULT 'replay' CHECK (kind IN ('replay')),
  passed           boolean     NOT NULL,
  score            numeric(4,3) CHECK (score BETWEEN 0 AND 1),
  evaluator        text        NOT NULL CHECK (evaluator IN ('rules', 'rules+model')),
  verdict          text        NOT NULL CHECK (char_length(verdict) BETWEEN 1 AND 1000),
  transcript       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id, skill_version_id)
    REFERENCES skill_versions (organization_id, member_id, id) ON DELETE CASCADE
);

CREATE INDEX skill_runs_version_idx ON skill_runs (skill_version_id, created_at DESC);

CREATE OR REPLACE FUNCTION app.reject_skill_run_change() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'replay evidence is appended, never changed'
    USING ERRCODE = 'check_violation', HINT = 'skill_run_immutable';
END;
$$;

CREATE TRIGGER skill_runs_no_change BEFORE UPDATE OR DELETE ON skill_runs
  FOR EACH ROW EXECUTE FUNCTION app.reject_skill_run_change();

-- A skill version's life. A bundled skill enters active (the catalogue was
-- reviewed); every other enters staging. Content and provenance are sealed.
-- staging → active needs a passing replay since it was staged and a person's
-- approval (approved_at) — and never a danger verdict.
CREATE OR REPLACE FUNCTION app.guard_skill_version() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  origin text;
BEGIN
  SELECT source INTO origin FROM skills WHERE id = NEW.skill_id;
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM skills WHERE id = NEW.skill_id FOR UPDATE;
    NEW.version := COALESCE((SELECT max(version) FROM skill_versions WHERE skill_id = NEW.skill_id), 0) + 1;
    NEW.created_at := clock_timestamp();
    IF NEW.state = 'active' AND origin <> 'bundled' THEN
      RAISE EXCEPTION 'a skill enters staging; only a reviewed bundled skill enters active'
        USING ERRCODE = 'check_violation', HINT = 'skill_replay_required';
    END IF;
    IF NEW.state NOT IN ('staging', 'active') OR NEW.approved_at IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'a skill version enters staging, undecided'
        USING ERRCODE = 'check_violation', HINT = 'skill_transition_invalid';
    END IF;
    IF NEW.state = 'active' AND NEW.scan_verdict = 'danger' THEN
      RAISE EXCEPTION 'a skill the scanner rates danger is never active'
        USING ERRCODE = 'check_violation', HINT = 'skill_danger';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.organization_id, NEW.member_id, NEW.skill_id, NEW.version, NEW.description, NEW.content, NEW.files,
      NEW.scan_verdict, NEW.findings, NEW.source_conversation_id, NEW.source_run_id, NEW.task, NEW.derived_from, NEW.created_at)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.member_id, OLD.skill_id, OLD.version, OLD.description, OLD.content, OLD.files,
      OLD.scan_verdict, OLD.findings, OLD.source_conversation_id, OLD.source_run_id, OLD.task, OLD.derived_from, OLD.created_at) THEN
    RAISE EXCEPTION 'skill version %: what it says and where it came from is sealed', OLD.id
      USING ERRCODE = 'check_violation', HINT = 'skill_version_immutable';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
         (OLD.state = 'staging' AND NEW.state IN ('active', 'rejected', 'revoked'))
      OR (OLD.state = 'active'  AND NEW.state IN ('revoked', 'superseded'))
    ) THEN
      RAISE EXCEPTION 'skill version % cannot go from % to %', OLD.id, OLD.state, NEW.state
        USING ERRCODE = 'check_violation', HINT = 'skill_transition_invalid';
    END IF;
    IF NEW.state = 'active' THEN
      IF OLD.scan_verdict = 'danger' THEN
        RAISE EXCEPTION 'a skill the scanner rates danger is never active'
          USING ERRCODE = 'check_violation', HINT = 'skill_danger';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM skill_runs r WHERE r.skill_version_id = OLD.id AND r.passed) THEN
        RAISE EXCEPTION 'skill version % has no passing replay', OLD.id
          USING ERRCODE = 'check_violation', HINT = 'skill_replay_required';
      END IF;
      IF NEW.approved_at IS NULL THEN
        RAISE EXCEPTION 'skill version % becomes active on a person''s approval or a trusted policy', OLD.id
          USING ERRCODE = 'check_violation', HINT = 'skill_approval_required';
      END IF;
    END IF;
    NEW.decided_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER skill_versions_guarded BEFORE INSERT OR UPDATE ON skill_versions
  FOR EACH ROW EXECUTE FUNCTION app.guard_skill_version();

-- ──────────────────────────────────────────────────────── row-level security
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

ALTER TABLE agent_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_versions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_versions
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON skills
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

ALTER TABLE skill_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_versions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON skill_versions
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

ALTER TABLE skill_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_runs FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON skill_runs
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

-- ───────────────────────────────────────────────────────────────── grants
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milyonuse_app') THEN
    REVOKE ALL ON agents, agent_versions, skills, skill_versions, skill_runs FROM milyonuse_app;
    GRANT SELECT, INSERT ON agents TO milyonuse_app;
    GRANT UPDATE (name, avatar, role_title, current_version_id, archived_at, updated_at) ON agents TO milyonuse_app;
    GRANT SELECT, INSERT ON agent_versions TO milyonuse_app;
    GRANT SELECT, INSERT ON skills TO milyonuse_app;
    GRANT UPDATE (enabled, current_version_id, updated_at) ON skills TO milyonuse_app;
    GRANT SELECT, INSERT ON skill_versions TO milyonuse_app;
    GRANT UPDATE (state, state_reason, approved_by, approved_at, decided_at) ON skill_versions TO milyonuse_app;
    GRANT SELECT, INSERT ON skill_runs TO milyonuse_app;
    GRANT UPDATE (agent_id) ON agent_conversations TO milyonuse_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milyonuse_platform') THEN
    REVOKE ALL ON agents, agent_versions, skills, skill_versions, skill_runs FROM milyonuse_platform;
    GRANT SELECT ON agents, agent_versions, skills, skill_versions, skill_runs TO milyonuse_platform;
  END IF;
END $$;
