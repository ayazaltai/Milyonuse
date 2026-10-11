-- 0008 — the memory clock is the server's.
--
-- 0007 judges time against created_at: an operator's T0 is activated no
-- sooner than 300 seconds after it was staged, and a demoted memory returns
-- only on a confirmation recorded after its demotion. Both columns took a
-- default, so a writer could name its own time — stage a T0 "ten minutes ago"
-- and activate it at once, or date a confirmation in the future. Here the
-- insert guards set the time themselves, whatever the statement said.

CREATE OR REPLACE FUNCTION app.guard_memory_insert() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT ((NEW.tier = 'T0' AND NEW.state = 't0_staged') OR (NEW.tier <> 'T0' AND NEW.state = 'pending')) THEN
    RAISE EXCEPTION 'memory % enters as %; only pending (or a staged T0) may be written', NEW.id, NEW.state
      USING ERRCODE = 'check_violation', HINT = 'memory_direct_write';
  END IF;
  IF NEW.tier < app.memory_tier_floor(NEW.source_kind) THEN
    RAISE EXCEPTION 'a % source cannot claim tier %', NEW.source_kind, NEW.tier
      USING ERRCODE = 'check_violation', HINT = 'memory_tier_exceeds_source';
  END IF;
  IF NEW.verified_at IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.reaffirm_count <> 0
     OR NEW.activation_signature IS NOT NULL THEN
    RAISE EXCEPTION 'memory % is written as a candidate, with no verdict yet', NEW.id
      USING ERRCODE = 'check_violation', HINT = 'memory_direct_write';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.guard_memory_confirmation() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  claim memory_items%ROWTYPE;
BEGIN
  SELECT * INTO claim FROM memory_items WHERE id = NEW.item_id;
  IF claim.state NOT IN ('pending', 'demoted') THEN
    RAISE EXCEPTION 'memory % is %; only a waiting claim is confirmed', NEW.item_id, claim.state
      USING ERRCODE = 'check_violation', HINT = 'memory_confirmation_not_independent';
  END IF;
  IF NEW.evidence_hash = claim.evidence_hash OR NEW.source_uri IS NOT DISTINCT FROM claim.source_uri THEN
    RAISE EXCEPTION 'memory %: a confirmation must come from other evidence and another source', NEW.item_id
      USING ERRCODE = 'check_violation', HINT = 'memory_confirmation_not_independent';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
