-- 0006_agent_core
-- The agent's conversations (Phase 1; source: App-Milyonus 0051, 0055, 0059,
-- 0062, 0065, 0047, generalised for Milyonuse).
--
-- A person talks to the agent; the agent answers, and reads with its tools.
-- Changing anything outside the conversation arrives in Phase 3, as proposals.
-- This file holds:
--
--   agent_conversations  one person's conversation — private to that member,
--                        in SQL, not only in the service: the policy names
--                        the member as well as the organization
--   agent_messages       what was said, append-only: the person, the agent,
--                        and what each tool answered
--   agent_attachments    a table or a document's text handed to the agent,
--                        kept a few days
--   agent_feedback       a person's rating of an answer
--   usage_daily          what is spent, per person and day and meter
--
-- Rules, for every caller:
--   a message belongs to its conversation's organization, and is never edited
--   an edit is a new message that revises an earlier one of the person's
--   the summary's boundary is one of the conversation's own messages and only
--     moves forward

-- ───────────────────────────────────────────────────────── conversations
CREATE TABLE agent_conversations (
  id                  ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id     ulid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  member_id           ulid        NOT NULL,
  title               text        NOT NULL DEFAULT 'New conversation'
                                  CHECK (char_length(title) BETWEEN 1 AND 120),
  -- A model router's identifier: `anthropic/claude-sonnet-5-5`.
  model               text        NOT NULL CHECK (model ~ '^[A-Za-z0-9._:/~-]{1,120}$'),
  pinned_at           timestamptz,
  last_message_at     timestamptz NOT NULL DEFAULT now(),
  -- A request to stop the running turn, from whichever instance took it: a
  -- turn polls this and stops when it is later than its own start.
  stop_requested_at   timestamptz,
  -- What the agent remembers of the conversation before its window: its own
  -- summary, read in place of the messages up to the boundary.
  summary             text        CHECK (summary IS NULL OR char_length(summary) BETWEEN 1 AND 24000),
  summary_through_id  ulid,
  summary_through_at  timestamptz,
  summarized_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id) REFERENCES members (organization_id, id) ON DELETE CASCADE,
  -- Target for the composite references below: a row names its conversation
  -- together with the conversation's organization and person.
  UNIQUE (organization_id, member_id, id),
  UNIQUE (organization_id, id),
  CONSTRAINT agent_conversations_summary_whole CHECK (
    (summary IS NULL) = (summary_through_id IS NULL)
    AND (summary IS NULL) = (summary_through_at IS NULL)
    AND (summary IS NULL) = (summarized_at IS NULL)
  )
);

CREATE INDEX agent_conversations_member_idx
  ON agent_conversations (organization_id, member_id, last_message_at DESC);

CREATE TRIGGER agent_conversations_updated_at BEFORE UPDATE ON agent_conversations
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ────────────────────────────────────────────────────────────── messages
CREATE TYPE agent_message_role AS ENUM ('user', 'assistant', 'tool');

CREATE TABLE agent_messages (
  id              ulid               PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid               NOT NULL,
  conversation_id ulid               NOT NULL,
  role            agent_message_role NOT NULL,
  content         text               NOT NULL DEFAULT '' CHECK (char_length(content) <= 200000),
  -- The tools the agent asked for: [{id, name, arguments}].
  tool_calls      jsonb              CHECK (tool_calls IS NULL OR jsonb_typeof(tool_calls) = 'array'),
  -- A tool's answer names the call it answers.
  tool_call_id    text               CHECK (char_length(tool_call_id) BETWEEN 1 AND 200),
  tool_name       text               CHECK (tool_name ~ '^[a-z_]{1,64}$'),
  -- Tables and documents handed over with a person's message: [{id, name, rows, kind?}].
  attachments     jsonb              CHECK (attachments IS NULL OR jsonb_typeof(attachments) = 'array'),
  -- An earlier message of the person's this one replaces: what lies between
  -- is superseded — kept, folded, no longer read by the agent.
  revises         ulid               REFERENCES agent_messages (id) ON DELETE CASCADE,
  -- For the agent's messages: which model answered, under which instructions,
  -- how it reasoned, and what it spent — as the model router reported it.
  model           text               CHECK (char_length(model) <= 200),
  prompt_version  text               CHECK (char_length(prompt_version) <= 40),
  reasoning       text               CHECK (char_length(reasoning) <= 40000),
  tokens_in       integer            CHECK (tokens_in >= 0),
  tokens_cached   integer            CHECK (tokens_cached >= 0),
  tokens_out      integer            CHECK (tokens_out >= 0),
  cost_usd        numeric(14, 8)     CHECK (cost_usd >= 0),
  -- The clock, not the transaction's start: one turn writes several messages
  -- in one transaction, and they are read back in the order they were written.
  created_at      timestamptz        NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, conversation_id)
    REFERENCES agent_conversations (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_messages_tool_answer
    CHECK ((role = 'tool') = (tool_call_id IS NOT NULL AND tool_name IS NOT NULL)),
  CONSTRAINT agent_messages_calls_are_the_agents
    CHECK (tool_calls IS NULL OR role = 'assistant'),
  CONSTRAINT agent_messages_spend_is_the_agents
    CHECK (role = 'assistant' OR (model IS NULL AND tokens_in IS NULL AND tokens_out IS NULL
                                  AND tokens_cached IS NULL AND cost_usd IS NULL AND reasoning IS NULL)),
  CONSTRAINT agent_messages_attachments_are_the_persons
    CHECK (attachments IS NULL OR role = 'user'),
  CONSTRAINT agent_messages_revisions_are_the_persons
    CHECK (revises IS NULL OR role = 'user')
);

CREATE INDEX agent_messages_conversation_idx ON agent_messages (conversation_id, created_at, id);
-- Words inside conversations: what people and the agent said, never a tool's answer.
CREATE INDEX agent_messages_search_idx
  ON agent_messages USING gin (content gin_trgm_ops)
  WHERE role IN ('user', 'assistant');

-- A message revises an earlier message of the person's, in the same conversation.
CREATE OR REPLACE FUNCTION app.assert_agent_revision() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.revises IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM agent_messages m
        WHERE m.id = NEW.revises AND m.conversation_id = NEW.conversation_id AND m.role = 'user') THEN
    RAISE EXCEPTION 'message % revises no message of the person''s in this conversation', NEW.id
      USING ERRCODE = 'check_violation', HINT = 'agent_revision_invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_messages_revision BEFORE INSERT ON agent_messages
  FOR EACH ROW EXECUTE FUNCTION app.assert_agent_revision();

-- A transcript of what the agent was told and did is not edited afterwards.
-- It goes with its conversation, and only then.
CREATE OR REPLACE FUNCTION app.reject_agent_message_change() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM agent_conversations c WHERE c.id = OLD.conversation_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'an agent message is written once (attempted %)', TG_OP
    USING ERRCODE = 'check_violation', HINT = 'agent_message_immutable';
END;
$$;

CREATE TRIGGER agent_messages_no_update BEFORE UPDATE ON agent_messages
  FOR EACH ROW EXECUTE FUNCTION app.reject_agent_message_change();
CREATE TRIGGER agent_messages_no_delete BEFORE DELETE ON agent_messages
  FOR EACH ROW EXECUTE FUNCTION app.reject_agent_message_change();

-- ─────────────────────────────────────────────────── the summary's boundary
-- Never taken back, always one of the conversation's own messages at its own
-- time, and only ever moved forward.
CREATE OR REPLACE FUNCTION app.guard_agent_summary() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.summary_through_id IS NOT DISTINCT FROM OLD.summary_through_id
     AND NEW.summary_through_at IS NOT DISTINCT FROM OLD.summary_through_at THEN
    RETURN NEW;
  END IF;
  IF NEW.summary_through_id IS NULL THEN
    RAISE EXCEPTION 'agent conversation %: a summary is never cleared', OLD.id
      USING ERRCODE = 'check_violation', HINT = 'agent_summary_boundary';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agent_messages m
     WHERE m.id = NEW.summary_through_id
       AND m.conversation_id = NEW.id
       AND m.created_at = NEW.summary_through_at
  ) THEN
    RAISE EXCEPTION 'agent conversation %: the summary must end at one of its own messages', OLD.id
      USING ERRCODE = 'check_violation', HINT = 'agent_summary_boundary';
  END IF;
  IF OLD.summary_through_id IS NOT NULL
     AND (NEW.summary_through_at, NEW.summary_through_id) <= (OLD.summary_through_at, OLD.summary_through_id) THEN
    RAISE EXCEPTION 'agent conversation %: a summary only moves forward', OLD.id
      USING ERRCODE = 'check_violation', HINT = 'agent_summary_boundary';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_conversations_summary
  BEFORE UPDATE OF summary_through_id, summary_through_at ON agent_conversations
  FOR EACH ROW EXECUTE FUNCTION app.guard_agent_summary();

-- ─────────────────────────────────────────────────────────── attachments
-- A table — pasted, CSV or .xlsx — kept as cells, or a document — PDF or
-- .docx — kept as its text, never the file. The model reads a table's first
-- line and asks for more; a document is read with a tool. A few days, then gone.
CREATE TABLE agent_attachments (
  id              ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid        NOT NULL,
  member_id       ulid        NOT NULL,
  conversation_id ulid        NOT NULL,
  kind            text        NOT NULL CHECK (kind IN ('table', 'document')),
  name            text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  rows            jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(rows) = 'array'),
  row_count       integer     NOT NULL DEFAULT 0,
  column_count    integer     NOT NULL DEFAULT 0,
  text            text        CHECK (text IS NULL OR char_length(text) <= 200000),
  pages           integer     CHECK (pages IS NULL OR pages BETWEEN 1 AND 500),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '7 days',
  -- The conversation's own person, in its own organization.
  FOREIGN KEY (organization_id, member_id, conversation_id)
    REFERENCES agent_conversations (organization_id, member_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_attachments_short_lived
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
  CONSTRAINT agent_attachments_shape CHECK (
    CASE kind
      WHEN 'table' THEN text IS NULL AND pages IS NULL
                        AND row_count BETWEEN 1 AND 10001 AND column_count BETWEEN 1 AND 50
      ELSE text IS NOT NULL AND char_length(text) >= 1
           AND jsonb_array_length(rows) = 0 AND row_count = 0 AND column_count = 0
    END)
);

CREATE INDEX agent_attachments_conversation_idx ON agent_attachments (conversation_id);
CREATE INDEX agent_attachments_expiry_idx ON agent_attachments (expires_at);

-- ────────────────────────────────────────────────────────────── feedback
-- One rating per person per answer, up or down with a note — kept with the
-- model and the instructions' version that gave the answer.
CREATE TABLE agent_feedback (
  id              ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid        NOT NULL,
  member_id       ulid        NOT NULL,
  message_id      ulid        NOT NULL REFERENCES agent_messages (id) ON DELETE CASCADE,
  rating          smallint    NOT NULL CHECK (rating IN (-1, 1)),
  note            text        NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
  -- Copied from the answer when rated: what is being judged.
  model           text,
  prompt_version  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id) REFERENCES members (organization_id, id) ON DELETE CASCADE,
  UNIQUE (message_id, member_id)
);

CREATE INDEX agent_feedback_org_idx ON agent_feedback (organization_id, created_at DESC);

CREATE TRIGGER agent_feedback_updated_at BEFORE UPDATE ON agent_feedback
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Only an answer of the agent's, in a conversation of the rater's own, is
-- rated; what it judges is copied from it.
CREATE OR REPLACE FUNCTION app.guard_agent_feedback() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  answer agent_messages%ROWTYPE;
BEGIN
  SELECT m.* INTO answer
    FROM agent_messages m JOIN agent_conversations c ON c.id = m.conversation_id
   WHERE m.id = NEW.message_id AND c.organization_id = NEW.organization_id AND c.member_id = NEW.member_id;
  IF NOT FOUND OR answer.role <> 'assistant' THEN
    RAISE EXCEPTION 'only an answer of the agent''s, in one''s own conversation, is rated (message %)', NEW.message_id
      USING ERRCODE = 'check_violation', HINT = 'agent_feedback_invalid';
  END IF;
  NEW.model := answer.model;
  NEW.prompt_version := answer.prompt_version;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_feedback_guarded BEFORE INSERT OR UPDATE OF message_id, member_id ON agent_feedback
  FOR EACH ROW EXECUTE FUNCTION app.guard_agent_feedback();

-- ─────────────────────────────────────────────────────────────── usage
-- What is spent, counted as it happens: one row per organization, person,
-- UTC day and meter (`agent.requests`, `agent.tokens`, …), with how many
-- times and how much. Added to, never rewritten: it is what a bill is
-- answered from, and what the daily ceilings are read from.
CREATE TABLE usage_daily (
  organization_id ulid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  member_id       ulid,
  day             date        NOT NULL,
  meter           text        NOT NULL CHECK (meter ~ '^[a-z]+\.[a-z_]+$'),
  events          integer     NOT NULL DEFAULT 0 CHECK (events >= 0),
  quantity        bigint      NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  last_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id) REFERENCES members (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT usage_daily_once UNIQUE NULLS NOT DISTINCT (organization_id, member_id, day, meter)
);

CREATE INDEX usage_daily_day_idx ON usage_daily (organization_id, day, meter);

-- A count only grows.
CREATE OR REPLACE FUNCTION app.protect_usage() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.organization_id, NEW.member_id, NEW.day, NEW.meter)
       IS DISTINCT FROM (OLD.organization_id, OLD.member_id, OLD.day, OLD.meter)
     OR NEW.events < OLD.events OR NEW.quantity < OLD.quantity THEN
    RAISE EXCEPTION 'a usage count only grows'
      USING ERRCODE = 'check_violation', HINT = 'usage_only_grows';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER usage_daily_grows BEFORE UPDATE ON usage_daily
  FOR EACH ROW EXECUTE FUNCTION app.protect_usage();

-- ──────────────────────────────────────────────────────── row-level security
-- A conversation, its messages, its attachments and the ratings in it are
-- one person's: the policies name the member in scope as well as the
-- organization, so a query that forgets to filter by person still sees only
-- that person's rows.
ALTER TABLE agent_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_conversations FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_conversations
  USING      (organization_id = (SELECT app.current_organization_id())
              AND member_id = (SELECT app.current_member_id()))
  WITH CHECK (organization_id = (SELECT app.current_organization_id())
              AND member_id = (SELECT app.current_member_id()));

ALTER TABLE agent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_messages FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_messages
  USING (organization_id = (SELECT app.current_organization_id())
         AND EXISTS (SELECT 1 FROM agent_conversations c WHERE c.id = agent_messages.conversation_id));

ALTER TABLE agent_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_attachments FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_attachments
  USING (organization_id = (SELECT app.current_organization_id())
         AND member_id = (SELECT app.current_member_id()));

ALTER TABLE agent_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_feedback FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_feedback
  USING (organization_id = (SELECT app.current_organization_id())
         AND member_id = (SELECT app.current_member_id()));

ALTER TABLE usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_daily FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_daily
  USING (organization_id = (SELECT app.current_organization_id()));

-- ───────────────────────────────────────────────────────────────── grants
-- The application role: a conversation is the person's to rename, pin and
-- delete; what was said is only added to; a usage count only grows. The
-- platform role deletes attachments past their days (the hourly pass).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milyonuse_app') THEN
    REVOKE ALL ON agent_conversations, agent_messages, agent_attachments, agent_feedback, usage_daily
      FROM milyonuse_app;
    GRANT SELECT, INSERT, DELETE ON agent_conversations TO milyonuse_app;
    GRANT UPDATE (title, model, pinned_at, last_message_at, stop_requested_at,
                  summary, summary_through_id, summary_through_at, summarized_at, updated_at)
      ON agent_conversations TO milyonuse_app;
    GRANT SELECT, INSERT ON agent_messages TO milyonuse_app;
    GRANT SELECT, INSERT ON agent_attachments TO milyonuse_app;
    GRANT SELECT, INSERT ON agent_feedback TO milyonuse_app;
    GRANT UPDATE (rating, note, updated_at) ON agent_feedback TO milyonuse_app;
    GRANT SELECT, INSERT ON usage_daily TO milyonuse_app;
    GRANT UPDATE (events, quantity, last_at) ON usage_daily TO milyonuse_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milyonuse_platform') THEN
    REVOKE ALL ON agent_conversations, agent_messages, agent_attachments, agent_feedback, usage_daily
      FROM milyonuse_platform;
    GRANT SELECT ON agent_conversations, agent_messages, agent_feedback, usage_daily TO milyonuse_platform;
    GRANT SELECT, DELETE ON agent_attachments TO milyonuse_platform;
  END IF;
END $$;
