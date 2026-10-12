-- 0012 — agent teams and runs (F5).
--
-- A team is a person's agents working together: a lead who plans, members who
-- take tasks, at most one reviewer, and a way of working — hierarchical (the
-- lead plans a graph of tasks), pipeline (each member's output is the next
-- one's input) or debate (members answer alone, the lead synthesises).
--
-- A run is one piece of work, advanced by the durable queue in slices: its
-- state machine, its task graph and its step log live here, so a run picks up
-- where it left off on any instance. A finished run is sealed; a step is
-- appended and never changed; a task's contract — what it was asked — is fixed
-- when it is made, and a task interrupted mid-way is `uncertain`, never run a
-- second time on its own: only a person's rerun, a new attempt, runs it again.
--
-- What members learn goes to the team's memory (scope = team), never straight
-- into the person's.

CREATE TYPE team_mode   AS ENUM ('hierarchical', 'pipeline', 'debate');
CREATE TYPE run_status  AS ENUM ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled');
CREATE TYPE task_status AS ENUM ('pending', 'running', 'done', 'failed', 'uncertain', 'cancelled');

-- ───────────────────────────────────────────────────────────────── teams
CREATE TABLE teams (
  id              ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid        NOT NULL,
  member_id       ulid        NOT NULL,
  name            text        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  purpose         text        NOT NULL DEFAULT '' CHECK (char_length(purpose) <= 1000),
  mode            team_mode   NOT NULL DEFAULT 'hierarchical',
  -- What one run may spend before it stops and asks.
  budget_tokens   integer     NOT NULL DEFAULT 400000 CHECK (budget_tokens BETWEEN 10000 AND 10000000),
  template        text        CHECK (template ~ '^[a-z][a-z0-9-]{1,40}$'),
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id) REFERENCES members (organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, member_id, id)
);

CREATE INDEX teams_member_idx ON teams (organization_id, member_id, archived_at, created_at);

CREATE TRIGGER teams_updated_at BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE team_members (
  id              ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid        NOT NULL,
  member_id       ulid        NOT NULL,
  team_id         ulid        NOT NULL,
  agent_id        ulid        NOT NULL,
  role            text        NOT NULL CHECK (role IN ('lead', 'member', 'reviewer')),
  -- A pipeline's order; the gallery's order otherwise.
  position        smallint    NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 20),
  specialty       text        NOT NULL DEFAULT '' CHECK (char_length(specialty) <= 300),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id, team_id) REFERENCES teams (organization_id, member_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, member_id, agent_id) REFERENCES agents (organization_id, member_id, id) ON DELETE CASCADE,
  UNIQUE (team_id, agent_id)
);

-- One lead and at most one reviewer per team.
CREATE UNIQUE INDEX team_members_one_lead ON team_members (team_id) WHERE role = 'lead';
CREATE UNIQUE INDEX team_members_one_reviewer ON team_members (team_id) WHERE role = 'reviewer';

-- A conversation may hold a team's runs: the result is said there, and what the run read taints it.
ALTER TABLE agent_conversations ADD COLUMN team_id ulid;
ALTER TABLE agent_conversations
  ADD CONSTRAINT agent_conversations_team FOREIGN KEY (organization_id, member_id, team_id)
    REFERENCES teams (organization_id, member_id, id) ON DELETE SET NULL (team_id);

-- ────────────────────────────────────────────────────────────────── runs
CREATE TABLE runs (
  id               ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id  ulid        NOT NULL,
  member_id        ulid        NOT NULL,
  parent_run_id    ulid,
  team_id          ulid,
  -- A child run's agent and the version it ran with.
  agent_id         ulid,
  agent_version_id ulid        REFERENCES agent_versions (id) ON DELETE SET NULL,
  conversation_id  ulid        NOT NULL,
  goal             text        NOT NULL CHECK (char_length(btrim(goal)) BETWEEN 1 AND 4000),
  mode             team_mode,
  status           run_status  NOT NULL DEFAULT 'queued',
  depth            smallint    NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 2),
  budget_tokens    integer     NOT NULL CHECK (budget_tokens BETWEEN 1000 AND 10000000),
  spent_tokens     bigint      NOT NULL DEFAULT 0 CHECK (spent_tokens >= 0),
  -- Review rounds asked for so far; the engine stops asking at two.
  revisions        smallint    NOT NULL DEFAULT 0 CHECK (revisions BETWEEN 0 AND 5),
  result           text        CHECK (char_length(result) <= 100000),
  error            text        CHECK (char_length(error) <= 2000),
  -- Who is advancing it now: a slice holds the run until this passes.
  lease_until      timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id) REFERENCES members (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, member_id, conversation_id)
    REFERENCES agent_conversations (organization_id, member_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, member_id, team_id) REFERENCES teams (organization_id, member_id, id) ON DELETE SET NULL (team_id),
  FOREIGN KEY (organization_id, member_id, agent_id) REFERENCES agents (organization_id, member_id, id) ON DELETE SET NULL (agent_id),
  UNIQUE (organization_id, member_id, id)
);

ALTER TABLE runs
  ADD CONSTRAINT runs_parent FOREIGN KEY (organization_id, member_id, parent_run_id)
    REFERENCES runs (organization_id, member_id, id) ON DELETE CASCADE;

CREATE INDEX runs_member_idx ON runs (organization_id, member_id, created_at DESC);
CREATE INDEX runs_team_idx ON runs (team_id, created_at DESC) WHERE team_id IS NOT NULL;
CREATE INDEX runs_parent_idx ON runs (parent_run_id) WHERE parent_run_id IS NOT NULL;

CREATE TRIGGER runs_updated_at BEFORE UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- A run's life:
--   queued → running | cancelled
--   running → waiting_approval | completed | failed | cancelled
--   waiting_approval → running | cancelled        (a person raised the budget, or stopped it)
--   failed → running | cancelled                  (a person reran a task)
-- completed and cancelled are sealed. What it is — whose, which team, which
-- goal, how deep — is fixed when it is made; what it spent only grows.
CREATE OR REPLACE FUNCTION app.guard_run() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  parent_depth smallint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'queued' OR NEW.spent_tokens <> 0 OR NEW.result IS NOT NULL OR NEW.finished_at IS NOT NULL THEN
      RAISE EXCEPTION 'a run starts queued, with nothing spent and no result'
        USING ERRCODE = 'check_violation', HINT = 'run_transition';
    END IF;
    IF NEW.parent_run_id IS NOT NULL THEN
      SELECT depth INTO parent_depth FROM runs WHERE id = NEW.parent_run_id;
      NEW.depth := COALESCE(parent_depth, 0) + 1;
    ELSE
      NEW.depth := 0;
    END IF;
    IF NEW.depth > 2 THEN
      RAISE EXCEPTION 'runs nest at most two deep'
        USING ERRCODE = 'check_violation', HINT = 'run_too_deep';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF OLD.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'run % is % and does not change', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', HINT = 'run_finished';
  END IF;
  IF (NEW.organization_id, NEW.member_id, NEW.parent_run_id, NEW.team_id, NEW.agent_id, NEW.conversation_id,
      NEW.goal, NEW.mode, NEW.depth, NEW.created_at)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.member_id, OLD.parent_run_id, OLD.team_id, OLD.agent_id, OLD.conversation_id,
      OLD.goal, OLD.mode, OLD.depth, OLD.created_at) THEN
    RAISE EXCEPTION 'run %: what it is was fixed when it was made', OLD.id
      USING ERRCODE = 'check_violation', HINT = 'run_identity_fixed';
  END IF;
  IF NEW.spent_tokens < OLD.spent_tokens THEN
    RAISE EXCEPTION 'run %: what was spent stays spent', OLD.id
      USING ERRCODE = 'check_violation', HINT = 'run_spend_backwards';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'queued' AND NEW.status IN ('running', 'cancelled'))
      OR (OLD.status = 'running' AND NEW.status IN ('waiting_approval', 'completed', 'failed', 'cancelled'))
      OR (OLD.status = 'waiting_approval' AND NEW.status IN ('running', 'cancelled'))
      OR (OLD.status = 'failed' AND NEW.status IN ('running', 'cancelled'))
    ) THEN
      RAISE EXCEPTION 'run % cannot go from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation', HINT = 'run_transition';
    END IF;
    IF NEW.status = 'running' AND OLD.started_at IS NULL THEN
      NEW.started_at := clock_timestamp();
    END IF;
    IF NEW.status IN ('completed', 'failed', 'cancelled') THEN
      NEW.finished_at := clock_timestamp();
      NEW.lease_until := NULL;
    ELSE
      NEW.finished_at := NULL;
    END IF;
  END IF;
  IF NEW.status = 'completed' AND NEW.result IS NULL THEN
    RAISE EXCEPTION 'run % completes with a result', OLD.id
      USING ERRCODE = 'check_violation', HINT = 'run_transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER runs_guarded BEFORE INSERT OR UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION app.guard_run();

CREATE OR REPLACE FUNCTION app.reject_run_delete() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  -- Removed only with what holds it — the conversation, the person.
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'a run is kept; it goes only with its conversation'
    USING ERRCODE = 'check_violation', HINT = 'run_finished';
END;
$$;

CREATE TRIGGER runs_no_delete BEFORE DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION app.reject_run_delete();

-- ───────────────────────────────────────────────────────────── run tasks
CREATE TABLE run_tasks (
  id                ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id   ulid        NOT NULL,
  member_id         ulid        NOT NULL,
  run_id            ulid        NOT NULL,
  key               text        NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  title             text        NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  -- The delegation contract: all a member sees of the run.
  goal              text        NOT NULL CHECK (char_length(btrim(goal)) BETWEEN 1 AND 4000),
  context           text        NOT NULL DEFAULT '' CHECK (char_length(context) <= 20000),
  success_criteria  text        NOT NULL DEFAULT '' CHECK (char_length(success_criteria) <= 2000),
  depends_on        text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(depends_on) <= 10),
  assigned_agent_id ulid,
  status            task_status NOT NULL DEFAULT 'pending',
  attempts          smallint    NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  output            text        CHECK (char_length(output) <= 60000),
  error             text        CHECK (char_length(error) <= 2000),
  tokens            integer     NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id, run_id) REFERENCES runs (organization_id, member_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, member_id, assigned_agent_id) REFERENCES agents (organization_id, member_id, id) ON DELETE SET NULL (assigned_agent_id),
  UNIQUE (run_id, key)
);

CREATE INDEX run_tasks_run_idx ON run_tasks (run_id, created_at);

-- A task's life. It is made pending, into a run still going, depending only on
-- tasks already in the run — so the graph has no cycle. Its contract never
-- changes. pending → running | cancelled; running → done | failed | uncertain
-- | cancelled; failed, uncertain or cancelled → pending only as a new attempt
-- (a reassignment, or a person's rerun). Done is done.
CREATE OR REPLACE FUNCTION app.guard_run_task() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  run_state run_status;
  missing   text;
BEGIN
  SELECT status INTO run_state FROM runs WHERE id = NEW.run_id;
  IF run_state IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'run % is % and its tasks do not change', NEW.run_id, run_state
      USING ERRCODE = 'check_violation', HINT = 'run_finished';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.output IS NOT NULL OR NEW.attempts <> 0 THEN
      RAISE EXCEPTION 'a task starts pending, with no output'
        USING ERRCODE = 'check_violation', HINT = 'task_transition';
    END IF;
    SELECT d INTO missing FROM unnest(NEW.depends_on) AS d
     WHERE d = NEW.key OR NOT EXISTS (SELECT 1 FROM run_tasks t WHERE t.run_id = NEW.run_id AND t.key = d)
     LIMIT 1;
    IF missing IS NOT NULL THEN
      RAISE EXCEPTION 'task % depends on %, which is not an earlier task of the run', NEW.key, missing
        USING ERRCODE = 'check_violation', HINT = 'task_dependency_unknown';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF (NEW.organization_id, NEW.member_id, NEW.run_id, NEW.key, NEW.title, NEW.goal, NEW.context, NEW.success_criteria,
      NEW.depends_on, NEW.created_at)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.member_id, OLD.run_id, OLD.key, OLD.title, OLD.goal, OLD.context, OLD.success_criteria,
      OLD.depends_on, OLD.created_at) THEN
    RAISE EXCEPTION 'task %: its contract was fixed when it was made', OLD.key
      USING ERRCODE = 'check_violation', HINT = 'task_contract_fixed';
  END IF;
  IF OLD.status = 'done' AND (NEW.status, NEW.output, NEW.tokens) IS DISTINCT FROM (OLD.status, OLD.output, OLD.tokens) THEN
    RAISE EXCEPTION 'task % is done', OLD.key
      USING ERRCODE = 'check_violation', HINT = 'task_transition';
  END IF;
  IF NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id AND NOT (OLD.status = 'pending' OR NEW.status = 'pending') THEN
    RAISE EXCEPTION 'task % is reassigned only while it waits', OLD.key
      USING ERRCODE = 'check_violation', HINT = 'task_transition';
  END IF;
  IF NEW.tokens < OLD.tokens THEN
    RAISE EXCEPTION 'task %: what was spent stays spent', OLD.key
      USING ERRCODE = 'check_violation', HINT = 'run_spend_backwards';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'pending' AND NEW.status IN ('running', 'cancelled'))
      OR (OLD.status = 'running' AND NEW.status IN ('done', 'failed', 'uncertain', 'cancelled'))
      OR (OLD.status IN ('failed', 'uncertain', 'cancelled') AND NEW.status = 'pending' AND NEW.attempts > OLD.attempts)
    ) THEN
      RAISE EXCEPTION 'task % cannot go from % to %', OLD.key, OLD.status, NEW.status
        USING ERRCODE = 'check_violation', HINT = 'task_transition';
    END IF;
    IF NEW.status = 'running' THEN
      NEW.started_at := clock_timestamp();
      NEW.finished_at := NULL;
    ELSIF NEW.status IN ('done', 'failed', 'uncertain', 'cancelled') THEN
      NEW.finished_at := clock_timestamp();
    ELSE
      NEW.started_at := NULL;
      NEW.finished_at := NULL;
      NEW.output := NULL;
      NEW.error := NULL;
    END IF;
  END IF;
  IF NEW.status = 'done' AND NEW.output IS NULL THEN
    RAISE EXCEPTION 'task % is done with an output', OLD.key
      USING ERRCODE = 'check_violation', HINT = 'task_transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER run_tasks_guarded BEFORE INSERT OR UPDATE ON run_tasks
  FOR EACH ROW EXECUTE FUNCTION app.guard_run_task();

-- ───────────────────────────────────────────────────────────── run steps
CREATE TABLE run_steps (
  id              ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid        NOT NULL,
  member_id       ulid        NOT NULL,
  run_id          ulid        NOT NULL,
  task_id         ulid        REFERENCES run_tasks (id) ON DELETE CASCADE,
  seq             integer     NOT NULL CHECK (seq >= 1),
  kind            text        NOT NULL CHECK (kind IN ('plan', 'assign', 'turn', 'tool', 'merge', 'review', 'budget', 'note', 'error', 'finish')),
  agent_id        ulid,
  summary         text        NOT NULL CHECK (char_length(btrim(summary)) BETWEEN 1 AND 500),
  detail          jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  tokens_in       integer     NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out      integer     NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id, run_id) REFERENCES runs (organization_id, member_id, id) ON DELETE CASCADE,
  UNIQUE (run_id, seq)
);

CREATE OR REPLACE FUNCTION app.guard_run_step() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM runs WHERE id = NEW.run_id FOR UPDATE;
    NEW.seq := COALESCE((SELECT max(seq) FROM run_steps WHERE run_id = NEW.run_id), 0) + 1;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'a run step is appended, never changed'
    USING ERRCODE = 'check_violation', HINT = 'run_step_immutable';
END;
$$;

CREATE TRIGGER run_steps_guarded BEFORE INSERT OR UPDATE OR DELETE ON run_steps
  FOR EACH ROW EXECUTE FUNCTION app.guard_run_step();

-- ──────────────────────────────────────────────────────────── team memory
-- 0011's guard learns the team branch: a team-scoped memory names one of the
-- person's teams.
CREATE OR REPLACE FUNCTION app.guard_memory_scope_ref() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scope = 'agent' AND NOT EXISTS (
       SELECT 1 FROM agents a
        WHERE a.id = NEW.scope_ref AND a.organization_id = NEW.organization_id AND a.member_id = NEW.member_id) THEN
    RAISE EXCEPTION 'memory scoped to agent % names no agent of this person', NEW.scope_ref
      USING ERRCODE = 'foreign_key_violation', HINT = 'memory_scope_unknown';
  END IF;
  IF NEW.scope = 'team' AND NOT EXISTS (
       SELECT 1 FROM teams t
        WHERE t.id = NEW.scope_ref AND t.organization_id = NEW.organization_id AND t.member_id = NEW.member_id) THEN
    RAISE EXCEPTION 'memory scoped to team % names no team of this person', NEW.scope_ref
      USING ERRCODE = 'foreign_key_violation', HINT = 'memory_scope_unknown';
  END IF;
  RETURN NEW;
END;
$$;

CREATE INDEX memory_items_team_scope_idx ON memory_items (scope_ref, state) WHERE scope = 'team';

-- ──────────────────────────────────────────────────────── row-level security
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON teams
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON team_members
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON runs
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

ALTER TABLE run_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_tasks FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON run_tasks
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

ALTER TABLE run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_steps FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON run_steps
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

-- ───────────────────────────────────────────────────────────────── grants
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milyonuse_app') THEN
    REVOKE ALL ON teams, team_members, runs, run_tasks, run_steps FROM milyonuse_app;
    GRANT SELECT, INSERT ON teams TO milyonuse_app;
    GRANT UPDATE (name, purpose, mode, budget_tokens, archived_at, updated_at) ON teams TO milyonuse_app;
    GRANT SELECT, INSERT, DELETE ON team_members TO milyonuse_app;
    GRANT UPDATE (role, position, specialty) ON team_members TO milyonuse_app;
    GRANT SELECT, INSERT ON runs TO milyonuse_app;
    GRANT UPDATE (status, budget_tokens, spent_tokens, revisions, result, error, lease_until, started_at, finished_at,
                  agent_version_id, updated_at) ON runs TO milyonuse_app;
    GRANT SELECT, INSERT ON run_tasks TO milyonuse_app;
    GRANT UPDATE (assigned_agent_id, status, attempts, output, error, tokens, started_at, finished_at) ON run_tasks TO milyonuse_app;
    GRANT SELECT, INSERT ON run_steps TO milyonuse_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milyonuse_platform') THEN
    REVOKE ALL ON teams, team_members, runs, run_tasks, run_steps FROM milyonuse_platform;
    GRANT SELECT ON teams, team_members, runs, run_tasks, run_steps TO milyonuse_platform;
    -- The hourly pass releases the lease of a run whose process died.
    GRANT UPDATE (lease_until) ON runs TO milyonuse_platform;
  END IF;
END $$;
