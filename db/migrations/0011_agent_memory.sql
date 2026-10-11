-- 0011 — an agent's own memory (F4).
--
-- 0007 left room for it: a memory's scope is `user` — every agent of the
-- person's reads it — or `agent`, naming one agent in scope_ref. An agent set
-- to its own memory reads the person's memory and its own, and what it learns
-- from its work is kept as its own; what the person says about themselves
-- stays the person's. Here the reference gets its key: an agent-scoped memory
-- names an agent of the same person, or it is refused. (A team's, in F5,
-- adds its own branch.)

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
  IF NEW.scope = 'team' THEN
    RAISE EXCEPTION 'team memory arrives with teams'
      USING ERRCODE = 'check_violation', HINT = 'memory_scope_unknown';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER memory_items_scope_ref BEFORE INSERT ON memory_items
  FOR EACH ROW EXECUTE FUNCTION app.guard_memory_scope_ref();

-- What a turn reads: the person's memory and, for an agent, its own.
CREATE INDEX memory_items_agent_scope_idx ON memory_items (scope_ref, state) WHERE scope = 'agent';
