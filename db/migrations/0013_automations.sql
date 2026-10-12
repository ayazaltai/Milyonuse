-- 0013 — automations (F6).
--
-- An automation runs one of the person's agents or teams without them at the
-- screen: on a schedule, when a watched page changes, toward a goal, when a
-- signed webhook or a mail arrives, when another run ends — or when they press
-- run. What it would change outside waits in their Inbox, as any proposal does.
--
-- The rules that must hold for every caller are here:
--   · when a schedule next runs is the database's to say, in the automation's
--     own time zone — 09:00 stays 09:00 across daylight-saving changes
--     (ported from App-Milyonus 0063, with hourly and monthly cadences);
--   · the same event starts one run: a trigger's dedupe key is unique per
--     automation;
--   · a chain of automations is at most three deep and never runs the same
--     automation twice;
--   · `trusted` is never the default and never set without the person's
--     explicit confirmation;
--   · three failures in a row pause an automation.

CREATE TYPE automation_kind AS ENUM ('schedule', 'monitor', 'goal', 'webhook', 'email', 'agent_event', 'manual');

-- The next instant after p_after at which a cadence falls, in p_zone. A local
-- time is turned into an instant on the day it falls, so the wall clock holds
-- across daylight-saving changes; a local time a spring-forward skips is the
-- first instant after it.
CREATE OR REPLACE FUNCTION app.automation_next(
  p_cadence text, p_weekdays smallint[], p_month_day smallint, p_time time, p_every_hours smallint, p_zone text, p_after timestamptz
) RETURNS timestamptz
  LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_first date := (p_after AT TIME ZONE p_zone)::date;
  v_day   date;
  v_at    timestamptz;
  v_hour  timestamp;
BEGIN
  IF p_cadence = 'hourly' THEN
    -- On the minute of p_time, every p_every_hours hours of the local day, counted from midnight.
    FOR i IN 0..(24 * 3) LOOP
      v_hour := date_trunc('hour', p_after AT TIME ZONE p_zone) + make_interval(hours => i, mins => extract(minute FROM p_time)::int);
      IF extract(hour FROM v_hour)::int % greatest(p_every_hours, 1) = 0 THEN
        v_at := v_hour AT TIME ZONE p_zone;
        IF v_at > p_after THEN
          RETURN v_at;
        END IF;
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  FOR i IN 0..62 LOOP
    v_day := v_first + i;
    v_at := (v_day + p_time) AT TIME ZONE p_zone;
    IF v_at > p_after AND (
         p_cadence = 'daily'
      OR (p_cadence = 'weekdays' AND extract(isodow FROM v_day) BETWEEN 1 AND 5)
      OR (p_cadence = 'weekly' AND extract(isodow FROM v_day)::smallint = ANY (p_weekdays))
      OR (p_cadence = 'monthly' AND extract(day FROM v_day)::smallint = least(p_month_day,
            extract(day FROM (date_trunc('month', v_day) + interval '1 month - 1 day'))::smallint))
    ) THEN
      RETURN v_at;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

-- ─────────────────────────────────────────────────────────── automations
CREATE TABLE automations (
  id                   ulid            PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id      ulid            NOT NULL,
  member_id            ulid            NOT NULL,
  name                 text            NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  kind                 automation_kind NOT NULL,
  enabled              boolean         NOT NULL DEFAULT true,
  -- What it runs: one of the person's agents, or one of their teams.
  target_agent_id      ulid,
  target_team_id       ulid,
  -- What the target is asked, each time; what arrived is added after it, fenced as data.
  prompt               text            NOT NULL CHECK (char_length(btrim(prompt)) BETWEEN 1 AND 4000),
  -- Unattended: only safe work runs; `trusted` also runs reversible work, and only once the person confirmed it.
  policy               text            NOT NULL DEFAULT 'safe_only' CHECK (policy IN ('safe_only', 'trusted')),
  trusted_confirmed_at timestamptz,
  time_zone            text            NOT NULL DEFAULT 'UTC' CHECK (char_length(time_zone) BETWEEN 1 AND 64),
  quiet_start          time,
  quiet_end            time,
  budget_tokens        integer         NOT NULL DEFAULT 200000 CHECK (budget_tokens BETWEEN 10000 AND 5000000),
  daily_cap            smallint        NOT NULL DEFAULT 24 CHECK (daily_cap BETWEEN 1 AND 500),
  failure_policy       text            NOT NULL DEFAULT 'pause' CHECK (failure_policy IN ('retry', 'pause', 'notify')),
  notify               text[]          NOT NULL DEFAULT '{inbox}' CHECK (notify <@ ARRAY['inbox', 'email']::text[]),
  -- schedule, monitor, goal: when.
  cadence              text            CHECK (cadence IN ('hourly', 'daily', 'weekdays', 'weekly', 'monthly')),
  weekdays             smallint[]      NOT NULL DEFAULT '{}' CHECK (weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  month_day            smallint        CHECK (month_day BETWEEN 1 AND 31),
  local_time           time,
  every_hours          smallint        CHECK (every_hours BETWEEN 1 AND 24),
  next_run_at          timestamptz,
  -- monitor: what to watch, and what change matters.
  monitor_url          text            CHECK (monitor_url ~ '^https://' AND char_length(monitor_url) <= 2000),
  monitor_condition    text            CHECK (char_length(monitor_condition) <= 500),
  -- goal: until when it keeps going.
  goal_until           date,
  -- webhook, email: the address's secret part. The signing key is derived from it, never stored.
  hook_token           text            UNIQUE CHECK (hook_token ~ '^[a-z0-9]{24,48}$'),
  -- agent_event: which runs it follows, and on what outcome.
  watch_automation_id  ulid,
  watch_team_id        ulid,
  watch_events         text[]          NOT NULL DEFAULT '{run.completed}' CHECK (watch_events <@ ARRAY['run.completed', 'run.failed']::text[]),
  consecutive_failures smallint        NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  paused_reason        text            CHECK (char_length(paused_reason) <= 500),
  last_run_at          timestamptz,
  last_outcome         text            CHECK (last_outcome IN ('completed', 'failed', 'skipped', 'waiting')),
  created_at           timestamptz     NOT NULL DEFAULT now(),
  updated_at           timestamptz     NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id) REFERENCES members (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, member_id, target_agent_id) REFERENCES agents (organization_id, member_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, member_id, target_team_id) REFERENCES teams (organization_id, member_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, member_id, watch_team_id) REFERENCES teams (organization_id, member_id, id) ON DELETE SET NULL (watch_team_id),
  UNIQUE (organization_id, member_id, id),
  CONSTRAINT automations_one_target CHECK (num_nonnulls(target_agent_id, target_team_id) = 1),
  CONSTRAINT automations_trusted_confirmed CHECK (policy = 'safe_only' OR trusted_confirmed_at IS NOT NULL),
  CONSTRAINT automations_quiet_pair CHECK ((quiet_start IS NULL) = (quiet_end IS NULL)),
  CONSTRAINT automations_due CHECK (NOT enabled OR kind NOT IN ('schedule', 'monitor', 'goal') OR next_run_at IS NOT NULL)
);

ALTER TABLE automations
  ADD CONSTRAINT automations_watch FOREIGN KEY (organization_id, member_id, watch_automation_id)
    REFERENCES automations (organization_id, member_id, id) ON DELETE SET NULL (watch_automation_id);

CREATE INDEX automations_member_idx ON automations (organization_id, member_id, created_at);
CREATE INDEX automations_due_idx ON automations (next_run_at) WHERE enabled AND next_run_at IS NOT NULL;
CREATE INDEX automations_watch_idx ON automations (watch_automation_id) WHERE kind = 'agent_event';
CREATE INDEX automations_watch_team_idx ON automations (watch_team_id) WHERE kind = 'agent_event';

CREATE TRIGGER automations_updated_at BEFORE UPDATE ON automations
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- What each kind needs, the next run of the timed ones, and the pause after
-- three failures in a row.
CREATE OR REPLACE FUNCTION app.guard_automation() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (SELECT count(*) FROM automations a WHERE a.member_id = NEW.member_id) >= 50 THEN
      RAISE EXCEPTION 'member % has fifty automations already', NEW.member_id
        USING ERRCODE = 'check_violation', HINT = 'automation_limit';
    END IF;
    NEW.consecutive_failures := 0;
  ELSIF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'an automation keeps its kind'
      USING ERRCODE = 'check_violation', HINT = 'automation_invalid';
  END IF;
  -- A zone that is not one is refused here, not at its first run.
  PERFORM now() AT TIME ZONE NEW.time_zone;
  IF NEW.kind IN ('schedule', 'monitor', 'goal') AND (NEW.cadence IS NULL OR NEW.local_time IS NULL
       OR (NEW.cadence = 'weekly' AND cardinality(NEW.weekdays) = 0)
       OR (NEW.cadence = 'monthly' AND NEW.month_day IS NULL)
       OR (NEW.cadence = 'hourly' AND NEW.every_hours IS NULL)) THEN
    RAISE EXCEPTION 'a % automation needs a complete schedule', NEW.kind
      USING ERRCODE = 'check_violation', HINT = 'automation_invalid';
  END IF;
  IF (NEW.kind = 'monitor' AND NEW.monitor_url IS NULL)
     OR (NEW.kind = 'goal' AND NEW.goal_until IS NULL)
     OR (NEW.kind IN ('webhook', 'email') AND NEW.hook_token IS NULL)
     OR (NEW.kind = 'agent_event' AND num_nonnulls(NEW.watch_automation_id, NEW.watch_team_id) = 0) THEN
    RAISE EXCEPTION 'a % automation is missing what it watches', NEW.kind
      USING ERRCODE = 'check_violation', HINT = 'automation_invalid';
  END IF;
  IF NEW.watch_automation_id = NEW.id THEN
    RAISE EXCEPTION 'an automation does not follow itself'
      USING ERRCODE = 'check_violation', HINT = 'automation_chain_loop';
  END IF;

  -- Turned back on: counted afresh. Three failures in a row: paused, with why.
  IF TG_OP = 'UPDATE' AND NEW.enabled AND NOT OLD.enabled THEN
    NEW.consecutive_failures := 0;
    NEW.paused_reason := NULL;
  END IF;
  IF NEW.consecutive_failures >= 3 AND NEW.enabled THEN
    NEW.enabled := false;
    NEW.paused_reason := 'Paused after three failures in a row.';
  END IF;

  IF NEW.kind IN ('schedule', 'monitor', 'goal') AND (
       TG_OP = 'INSERT'
       OR (NEW.cadence, NEW.weekdays, NEW.month_day, NEW.local_time, NEW.every_hours, NEW.time_zone)
          IS DISTINCT FROM (OLD.cadence, OLD.weekdays, OLD.month_day, OLD.local_time, OLD.every_hours, OLD.time_zone)
       OR (NEW.enabled AND NOT OLD.enabled)) THEN
    NEW.next_run_at := app.automation_next(NEW.cadence, NEW.weekdays, NEW.month_day, NEW.local_time, NEW.every_hours, NEW.time_zone, now());
  ELSIF NEW.kind NOT IN ('schedule', 'monitor', 'goal') THEN
    NEW.next_run_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER automations_guarded BEFORE INSERT OR UPDATE ON automations
  FOR EACH ROW EXECUTE FUNCTION app.guard_automation();

-- ──────────────────────────────────────────────────────────────── triggers
-- Every event an automation received, once: the dedupe key is the event's
-- identity (a schedule's due instant, a webhook's delivery id, a run's id),
-- so the same event twice is refused rather than run twice.
CREATE TABLE automation_triggers (
  id              ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid        NOT NULL,
  member_id       ulid        NOT NULL,
  automation_id   ulid        NOT NULL,
  source          text        NOT NULL CHECK (source IN ('schedule', 'monitor', 'goal', 'webhook', 'email', 'agent_event', 'manual', 'test')),
  dedupe_key      text        NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(payload) <= 65536),
  -- The automations this event passed through to get here, oldest first.
  chain           ulid[]      NOT NULL DEFAULT '{}',
  status          text        NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'started', 'skipped', 'failed')),
  reason          text        CHECK (char_length(reason) <= 500),
  run_id          ulid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id, automation_id) REFERENCES automations (organization_id, member_id, id) ON DELETE CASCADE,
  CONSTRAINT automation_triggers_once UNIQUE (automation_id, dedupe_key)
);

CREATE INDEX automation_triggers_automation_idx ON automation_triggers (automation_id, created_at DESC);
CREATE INDEX automation_triggers_run_idx ON automation_triggers (run_id) WHERE run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app.guard_automation_trigger() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF cardinality(NEW.chain) >= 3 THEN
      RAISE EXCEPTION 'a chain of automations is at most three deep'
        USING ERRCODE = 'check_violation', HINT = 'automation_chain_too_deep';
    END IF;
    IF NEW.automation_id = ANY (NEW.chain) THEN
      RAISE EXCEPTION 'automation % already ran in this chain', NEW.automation_id
        USING ERRCODE = 'check_violation', HINT = 'automation_chain_loop';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (NEW.automation_id, NEW.source, NEW.dedupe_key, NEW.payload, NEW.chain, NEW.created_at)
     IS DISTINCT FROM (OLD.automation_id, OLD.source, OLD.dedupe_key, OLD.payload, OLD.chain, OLD.created_at) THEN
    RAISE EXCEPTION 'what arrived is a record and does not change'
      USING ERRCODE = 'check_violation', HINT = 'automation_trigger_immutable';
  END IF;
  IF OLD.status <> 'accepted' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a trigger is decided once'
      USING ERRCODE = 'check_violation', HINT = 'automation_trigger_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER automation_triggers_guarded BEFORE INSERT OR UPDATE ON automation_triggers
  FOR EACH ROW EXECUTE FUNCTION app.guard_automation_trigger();

-- ─────────────────────────────────────────────────────────── monitor state
CREATE TABLE monitor_state (
  automation_id   ulid        PRIMARY KEY,
  organization_id ulid        NOT NULL,
  member_id       ulid        NOT NULL,
  last_hash       text        CHECK (last_hash ~ '^[0-9a-f]{64}$'),
  last_excerpt    text        CHECK (char_length(last_excerpt) <= 4000),
  checks          integer     NOT NULL DEFAULT 0 CHECK (checks >= 0),
  changes         integer     NOT NULL DEFAULT 0 CHECK (changes >= 0),
  last_checked_at timestamptz,
  last_changed_at timestamptz,
  FOREIGN KEY (organization_id, member_id, automation_id) REFERENCES automations (organization_id, member_id, id) ON DELETE CASCADE
);

-- ──────────────────────────────────────────────────── runs of automations
ALTER TABLE runs ADD COLUMN automation_id ulid;
ALTER TABLE runs ADD COLUMN unattended_policy text CHECK (unattended_policy IN ('safe_only', 'trusted'));
ALTER TABLE runs
  ADD CONSTRAINT runs_automation FOREIGN KEY (organization_id, member_id, automation_id)
    REFERENCES automations (organization_id, member_id, id) ON DELETE SET NULL (automation_id);
CREATE INDEX runs_automation_idx ON runs (automation_id, created_at DESC) WHERE automation_id IS NOT NULL;

-- 0012's guard learns the new identity: which automation started a run, and
-- under which policy, is fixed when it is made.
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
      NEW.goal, NEW.mode, NEW.depth, NEW.created_at, NEW.automation_id, NEW.unattended_policy)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.member_id, OLD.parent_run_id, OLD.team_id, OLD.agent_id, OLD.conversation_id,
      OLD.goal, OLD.mode, OLD.depth, OLD.created_at, OLD.automation_id, OLD.unattended_policy) THEN
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

-- ───────────────────────────────────────────────────────────────── inbox
-- What the person should see that is not already a proposal, a waiting run or
-- a memory to approve (those are read where they live): an automation's
-- alerts, a suggestion to automate, a notice. Read, resolved, never rewritten.
CREATE TABLE inbox_items (
  id              ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid        NOT NULL,
  member_id       ulid        NOT NULL,
  kind            text        NOT NULL CHECK (kind IN ('alert', 'suggestion', 'notice')),
  title           text        NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  body            text        NOT NULL DEFAULT '' CHECK (char_length(body) <= 2000),
  link            text        CHECK (link ~ '^/app/' AND char_length(link) <= 300),
  automation_id   ulid,
  -- A suggestion's automation, ready to be made; an alert's facts.
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(payload) <= 16384),
  -- The same suggestion or alert is made once.
  dedupe_key      text        CHECK (char_length(dedupe_key) <= 200),
  read_at         timestamptz,
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id) REFERENCES members (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, member_id, automation_id) REFERENCES automations (organization_id, member_id, id) ON DELETE CASCADE,
  CONSTRAINT inbox_items_once UNIQUE (member_id, dedupe_key)
);

CREATE INDEX inbox_items_member_idx ON inbox_items (organization_id, member_id, resolved_at, created_at DESC);

-- ──────────────────────────────────────────────────────── row-level security
ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automations
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

ALTER TABLE automation_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_triggers FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_triggers
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

ALTER TABLE monitor_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitor_state FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON monitor_state
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

ALTER TABLE inbox_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_items FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inbox_items
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

-- ───────────────────────────────────────────────────────────────── grants
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milyonuse_app') THEN
    REVOKE ALL ON automations, automation_triggers, monitor_state, inbox_items FROM milyonuse_app;
    GRANT SELECT, INSERT, DELETE ON automations TO milyonuse_app;
    GRANT UPDATE (name, enabled, target_agent_id, target_team_id, prompt, policy, trusted_confirmed_at, time_zone,
                  quiet_start, quiet_end, budget_tokens, daily_cap, failure_policy, notify, cadence, weekdays,
                  month_day, local_time, every_hours, next_run_at, monitor_url, monitor_condition, goal_until,
                  hook_token, watch_automation_id, watch_team_id, watch_events, consecutive_failures,
                  paused_reason, last_run_at, last_outcome, updated_at) ON automations TO milyonuse_app;
    GRANT SELECT, INSERT ON automation_triggers TO milyonuse_app;
    GRANT UPDATE (status, reason, run_id) ON automation_triggers TO milyonuse_app;
    GRANT SELECT, INSERT ON monitor_state TO milyonuse_app;
    GRANT UPDATE (last_hash, last_excerpt, checks, changes, last_checked_at, last_changed_at) ON monitor_state TO milyonuse_app;
    GRANT SELECT, INSERT ON inbox_items TO milyonuse_app;
    GRANT UPDATE (read_at, resolved_at) ON inbox_items TO milyonuse_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milyonuse_platform') THEN
    REVOKE ALL ON automations, automation_triggers, monitor_state, inbox_items FROM milyonuse_platform;
    -- The minute pass finds what is due, and a hook finds its automation by its token, before any tenant is known.
    GRANT SELECT ON automations, automation_triggers, monitor_state, inbox_items TO milyonuse_platform;
    GRANT UPDATE (next_run_at) ON automations TO milyonuse_platform;
  END IF;
END $$;
