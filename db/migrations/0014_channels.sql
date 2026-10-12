-- 0014 — channels (F7).
--
-- A person talks to their agents from Telegram, WhatsApp, Slack, Discord or
-- mail. Milyonuse runs one bot per channel; a person's identity on a channel
-- is bound to their account by a code they make in the app and send from the
-- channel. Nothing an unbound identity sends is answered.
--
-- The rules that must hold for every caller are here:
--   · a code is stored as a digest, lives an hour and is used once; a newer
--     code for the same channel replaces an older one;
--   · five wrong codes from one identity lock it for an hour — counted before
--     any tenant is known, so in a table of its own;
--   · an identity on a channel is bound to one person at a time;
--   · the same delivery from a channel is handled once;
--   · a `channel` automation starts on its own command, unique per person.

CREATE TYPE channel_provider AS ENUM ('telegram', 'whatsapp', 'slack', 'discord', 'email');

-- ──────────────────────────────────────────────────────────── identities
CREATE TABLE channel_identities (
  id               ulid             PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id  ulid             NOT NULL,
  member_id        ulid             NOT NULL,
  provider         channel_provider NOT NULL,
  -- The channel's own id for the person: a Telegram user id, a WhatsApp number, a Slack `team:user`, an address.
  external_id      text             NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
  display_name     text             NOT NULL DEFAULT '' CHECK (char_length(display_name) <= 120),
  -- Who answers there: one of the person's agents or teams, or the plain agent when neither.
  default_agent_id ulid,
  default_team_id  ulid,
  -- Notices the person did not ask for wait outside these hours, in their zone.
  quiet_start      time,
  quiet_end        time,
  time_zone        text             NOT NULL DEFAULT 'UTC' CHECK (char_length(time_zone) BETWEEN 1 AND 64),
  paired_at        timestamptz      NOT NULL DEFAULT now(),
  last_seen_at     timestamptz,
  revoked_at       timestamptz,
  FOREIGN KEY (organization_id, member_id) REFERENCES members (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, member_id, default_agent_id) REFERENCES agents (organization_id, member_id, id) ON DELETE SET NULL (default_agent_id),
  FOREIGN KEY (organization_id, member_id, default_team_id) REFERENCES teams (organization_id, member_id, id) ON DELETE SET NULL (default_team_id),
  UNIQUE (organization_id, member_id, id),
  CONSTRAINT channel_identities_one_target CHECK (num_nonnulls(default_agent_id, default_team_id) <= 1),
  CONSTRAINT channel_identities_quiet_pair CHECK ((quiet_start IS NULL) = (quiet_end IS NULL))
);

-- One live binding per identity on a channel: a second person cannot claim it while the first holds it.
CREATE UNIQUE INDEX channel_identities_live ON channel_identities (provider, external_id) WHERE revoked_at IS NULL;
CREATE INDEX channel_identities_member_idx ON channel_identities (organization_id, member_id, paired_at DESC);

CREATE OR REPLACE FUNCTION app.guard_channel_identity() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM now() AT TIME ZONE NEW.time_zone;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.organization_id, NEW.member_id, NEW.provider, NEW.external_id, NEW.paired_at)
       IS DISTINCT FROM (OLD.organization_id, OLD.member_id, OLD.provider, OLD.external_id, OLD.paired_at) THEN
      RAISE EXCEPTION 'a channel identity keeps who and where it is'
        USING ERRCODE = 'check_violation', HINT = 'channel_identity_fixed';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
      RAISE EXCEPTION 'a revoked channel identity stays revoked; pair it again'
        USING ERRCODE = 'check_violation', HINT = 'channel_identity_fixed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER channel_identities_guarded BEFORE INSERT OR UPDATE ON channel_identities
  FOR EACH ROW EXECUTE FUNCTION app.guard_channel_identity();

-- ────────────────────────────────────────────────────────────── pairings
-- A code the person made in the app, as a digest. Redeeming it is the only way
-- an identity is bound.
CREATE TABLE channel_pairings (
  id              ulid             PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid             NOT NULL,
  member_id       ulid             NOT NULL,
  provider        channel_provider NOT NULL,
  code_digest     text             NOT NULL UNIQUE CHECK (code_digest ~ '^[0-9a-f]{64}$'),
  expires_at      timestamptz      NOT NULL DEFAULT now() + interval '1 hour',
  used_at         timestamptz,
  identity_id     ulid,
  created_at      timestamptz      NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id) REFERENCES members (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, member_id, identity_id) REFERENCES channel_identities (organization_id, member_id, id) ON DELETE SET NULL (identity_id),
  CONSTRAINT channel_pairings_short_lived CHECK (expires_at <= created_at + interval '1 hour'),
  CONSTRAINT channel_pairings_used CHECK (identity_id IS NULL OR used_at IS NOT NULL)
);

CREATE INDEX channel_pairings_member_idx ON channel_pairings (organization_id, member_id, provider, created_at DESC);

CREATE OR REPLACE FUNCTION app.guard_channel_pairing() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.used_at := NULL;
    NEW.identity_id := NULL;
    IF NEW.expires_at > NEW.created_at + interval '1 hour' THEN
      NEW.expires_at := NEW.created_at + interval '1 hour';
    END IF;
    -- A newer code replaces an older one still waiting for the same channel.
    UPDATE channel_pairings p SET expires_at = least(p.expires_at, now())
     WHERE p.member_id = NEW.member_id AND p.provider = NEW.provider AND p.used_at IS NULL AND p.expires_at > now();
    RETURN NEW;
  END IF;
  IF (NEW.organization_id, NEW.member_id, NEW.provider, NEW.code_digest, NEW.created_at)
     IS DISTINCT FROM (OLD.organization_id, OLD.member_id, OLD.provider, OLD.code_digest, OLD.created_at)
     OR NEW.expires_at > OLD.expires_at THEN
    RAISE EXCEPTION 'a pairing code does not change'
      USING ERRCODE = 'check_violation', HINT = 'channel_pairing_used';
  END IF;
  IF OLD.used_at IS NOT NULL AND (NEW.used_at IS DISTINCT FROM OLD.used_at OR NEW.identity_id IS DISTINCT FROM OLD.identity_id) THEN
    RAISE EXCEPTION 'a pairing code is used once'
      USING ERRCODE = 'check_violation', HINT = 'channel_pairing_used';
  END IF;
  IF OLD.used_at IS NULL AND NEW.used_at IS NOT NULL AND OLD.expires_at <= now() THEN
    RAISE EXCEPTION 'that pairing code has expired'
      USING ERRCODE = 'check_violation', HINT = 'channel_pairing_expired';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER channel_pairings_guarded BEFORE INSERT OR UPDATE ON channel_pairings
  FOR EACH ROW EXECUTE FUNCTION app.guard_channel_pairing();

-- ────────────────────────────────────────────────── wrong codes, per identity
-- Counted before any tenant is known — the identity has none yet — so this
-- table has no organization and is the platform role's alone.
CREATE TABLE channel_pairing_locks (
  provider      channel_provider NOT NULL,
  external_id   text             NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
  failures      smallint         NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 5),
  locked_until  timestamptz,
  updated_at    timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, external_id)
);

-- One wrong code more: the fifth locks the identity for an hour and starts the count again.
CREATE OR REPLACE FUNCTION app.channel_pairing_failed(p_provider channel_provider, p_external_id text)
  RETURNS timestamptz
  LANGUAGE sql
AS $$
  INSERT INTO channel_pairing_locks AS l (provider, external_id, failures, locked_until, updated_at)
  VALUES (p_provider, p_external_id, 1, NULL, now())
  ON CONFLICT (provider, external_id) DO UPDATE
    SET failures     = CASE WHEN l.failures + 1 >= 5 THEN 0 ELSE l.failures + 1 END,
        locked_until = CASE WHEN l.failures + 1 >= 5 THEN now() + interval '1 hour' ELSE l.locked_until END,
        updated_at   = now()
  RETURNING locked_until;
$$;

-- ──────────────────────────────────────────────────────────────── threads
-- Where a chat's messages go: the conversation it continues. `/new` points it
-- at a fresh one; the old conversation stays.
CREATE TABLE channel_threads (
  id              ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid        NOT NULL,
  member_id       ulid        NOT NULL,
  identity_id     ulid        NOT NULL,
  -- Where a reply goes: a chat, a channel, a DM, an address.
  chat_id         text        NOT NULL CHECK (char_length(chat_id) BETWEEN 1 AND 200),
  is_group        boolean     NOT NULL DEFAULT false,
  conversation_id ulid        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id, identity_id) REFERENCES channel_identities (organization_id, member_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, member_id, conversation_id) REFERENCES agent_conversations (organization_id, member_id, id) ON DELETE CASCADE,
  CONSTRAINT channel_threads_one UNIQUE (identity_id, chat_id)
);

CREATE INDEX channel_threads_conversation_idx ON channel_threads (conversation_id);

-- ───────────────────────────────────────────────────── deliveries, once each
-- A channel retries what it thinks was not received. Its own delivery id is
-- kept a week, before any tenant is known.
CREATE TABLE channel_events (
  provider    channel_provider NOT NULL,
  event_id    text             NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 200),
  received_at timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

CREATE INDEX channel_events_received_idx ON channel_events (received_at);

-- ─────────────────────────────────────────────── channel-started automations
ALTER TYPE automation_kind ADD VALUE IF NOT EXISTS 'channel';

-- `/report` in any paired chat starts the automation that answers to it.
ALTER TABLE automations ADD COLUMN channel_command text CHECK (channel_command ~ '^[a-z][a-z0-9_]{0,31}$');
CREATE UNIQUE INDEX automations_channel_command ON automations (member_id, channel_command) WHERE channel_command IS NOT NULL;

ALTER TABLE automation_triggers DROP CONSTRAINT automation_triggers_source_check;
ALTER TABLE automation_triggers ADD CONSTRAINT automation_triggers_source_check
  CHECK (source IN ('schedule', 'monitor', 'goal', 'webhook', 'email', 'agent_event', 'manual', 'test', 'channel'));

-- 0013's guard, with what a channel automation needs: its command, and only it.
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
  IF NEW.kind::text IN ('schedule', 'monitor', 'goal') AND (NEW.cadence IS NULL OR NEW.local_time IS NULL
       OR (NEW.cadence = 'weekly' AND cardinality(NEW.weekdays) = 0)
       OR (NEW.cadence = 'monthly' AND NEW.month_day IS NULL)
       OR (NEW.cadence = 'hourly' AND NEW.every_hours IS NULL)) THEN
    RAISE EXCEPTION 'a % automation needs a complete schedule', NEW.kind
      USING ERRCODE = 'check_violation', HINT = 'automation_invalid';
  END IF;
  IF (NEW.kind::text = 'monitor' AND NEW.monitor_url IS NULL)
     OR (NEW.kind::text = 'goal' AND NEW.goal_until IS NULL)
     OR (NEW.kind::text IN ('webhook', 'email') AND NEW.hook_token IS NULL)
     OR (NEW.kind::text = 'agent_event' AND num_nonnulls(NEW.watch_automation_id, NEW.watch_team_id) = 0)
     OR ((NEW.kind::text = 'channel') <> (NEW.channel_command IS NOT NULL)) THEN
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

  IF NEW.kind::text IN ('schedule', 'monitor', 'goal') AND (
       TG_OP = 'INSERT'
       OR (NEW.cadence, NEW.weekdays, NEW.month_day, NEW.local_time, NEW.every_hours, NEW.time_zone)
          IS DISTINCT FROM (OLD.cadence, OLD.weekdays, OLD.month_day, OLD.local_time, OLD.every_hours, OLD.time_zone)
       OR (NEW.enabled AND NOT OLD.enabled)) THEN
    NEW.next_run_at := app.automation_next(NEW.cadence, NEW.weekdays, NEW.month_day, NEW.local_time, NEW.every_hours, NEW.time_zone, now());
  ELSIF NEW.kind::text NOT IN ('schedule', 'monitor', 'goal') THEN
    NEW.next_run_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- ──────────────────────────────────────────────────────── row-level security
ALTER TABLE channel_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_identities FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON channel_identities
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

ALTER TABLE channel_pairings ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_pairings FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON channel_pairings
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

ALTER TABLE channel_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_threads FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON channel_threads
  USING      (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id()) AND member_id = (SELECT app.current_member_id()));

-- ───────────────────────────────────────────────────────────────── grants
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milyonuse_app') THEN
    REVOKE ALL ON channel_identities, channel_pairings, channel_threads, channel_pairing_locks, channel_events FROM milyonuse_app;
    GRANT SELECT, INSERT ON channel_identities TO milyonuse_app;
    GRANT UPDATE (display_name, default_agent_id, default_team_id, quiet_start, quiet_end, time_zone, last_seen_at, revoked_at)
      ON channel_identities TO milyonuse_app;
    GRANT SELECT, INSERT ON channel_pairings TO milyonuse_app;
    GRANT UPDATE (expires_at, used_at, identity_id) ON channel_pairings TO milyonuse_app;
    GRANT SELECT, INSERT ON channel_threads TO milyonuse_app;
    GRANT UPDATE (conversation_id, last_message_at, is_group) ON channel_threads TO milyonuse_app;
    GRANT UPDATE (channel_command) ON automations TO milyonuse_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milyonuse_platform') THEN
    REVOKE ALL ON channel_identities, channel_pairings, channel_threads, channel_pairing_locks, channel_events FROM milyonuse_platform;
    -- A message arrives with only a channel's id for its sender: who that is, and a code's owner, are read before any tenant is known.
    GRANT SELECT ON channel_identities, channel_pairings TO milyonuse_platform;
    GRANT SELECT, INSERT, UPDATE, DELETE ON channel_pairing_locks, channel_events TO milyonuse_platform;
    GRANT EXECUTE ON FUNCTION app.channel_pairing_failed(channel_provider, text) TO milyonuse_platform;
  END IF;
END $$;
