-- 0007_memory
-- Verified memory (Phase 2; source: Agent 5.5 memory/store.py and model.py,
-- moved from SQLite into Postgres with the ten known gaps closed in SQL —
-- docs/phases/F2-verified-memory.md §3).
--
-- What an agent remembers about a person and the world, with who said it,
-- where it came from and whether it was verified — always. Nothing reaches
-- `active` by being written: a candidate enters `pending` and is promoted by
-- the rules below, and every step is in a hash-chained ledger.
--
--   memory_items          the memories themselves, with sealed provenance
--   memory_confirmations  independent evidence for a third-party claim (T3)
--   memory_derivations    what a memory was derived from: the sources its run
--                         read, and earlier memories — the revocation graph
--   memory_negative       what was rejected, so a rephrase is caught
--   memory_ledger         sha256-chained, per organization, append-only
--   run_taint             the outside sources an agent turn read
--
-- Rules, for every caller:
--   a memory enters pending (or, for an operator's signed T0, staged) — never active
--   its tier is never more trusted than its source allows (no laundering)
--   content, provenance and evidence never change after the write
--   state moves only along the lifecycle; rejected, revoked and expired are final
--   a T3 claim is promoted only on two independent confirmations
--   a T4 claim is promoted only by the person's approval
--   a demoted memory comes back only on new evidence, and under a lower ceiling
--   a staged T0 is activated only with a second signature, after its review gap
--   every write and transition is ledgered, and the ledger is only appended to

CREATE TYPE memory_tier        AS ENUM ('T0', 'T1', 'T2', 'T3', 'T4');
CREATE TYPE memory_state       AS ENUM ('pending', 'active', 'demoted', 'rejected', 'revoked', 'expired', 't0_staged');
CREATE TYPE memory_source_kind AS ENUM ('operator', 'user_direct', 'agent_observed', 'third_party', 'subagent', 'unknown');
CREATE TYPE memory_scope       AS ENUM ('user', 'agent', 'team');

-- ─────────────────────────────────────────────────────────────────── items
CREATE TABLE memory_items (
  id                    ulid               PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id       ulid               NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  -- Whose memory it is. Null only for an operator's T0, which holds for the
  -- whole organization.
  member_id             ulid,
  -- `user`: every agent of the person's. `agent` and `team` name their agent
  -- or team in scope_ref (Phases 4 and 5 add the reference's key).
  scope                 memory_scope       NOT NULL DEFAULT 'user',
  scope_ref             ulid,
  content               text               NOT NULL CHECK (char_length(btrim(content)) BETWEEN 1 AND 2000),
  tier                  memory_tier        NOT NULL,
  state                 memory_state       NOT NULL,
  -- Provenance, sealed: where it came from, in which run, said by whom.
  source_kind           memory_source_kind NOT NULL,
  source_uri            text               CHECK (char_length(source_uri) BETWEEN 1 AND 2000),
  conversation_id       ulid,
  run_id                ulid,
  actor                 text               NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 200),
  -- sha256 binding the content to its provenance (memory.ts evidenceHash).
  evidence_hash         text               NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  -- Security- or authority-touching memory decays four times as fast.
  sensitivity           text               NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal', 'sensitive')),
  -- Trust: ceiling × 0.5^(age / half-life), computed when read, never stored.
  trust_ceiling         numeric(4, 3)      NOT NULL DEFAULT 1 CHECK (trust_ceiling > 0 AND trust_ceiling <= 1),
  last_reaffirmed_at    timestamptz,
  reaffirm_count        integer            NOT NULL DEFAULT 0 CHECK (reaffirm_count >= 0),
  -- The lifecycle, and why it last moved.
  state_reason          text               CHECK (char_length(state_reason) <= 500),
  verdict               text               CHECK (char_length(verdict) <= 500),
  verified_at           timestamptz,
  demoted_at            timestamptz,
  expires_at            timestamptz,
  approved_by           ulid,
  approved_at           timestamptz,
  -- An operator's T0: the signature over the content, the key it verifies
  -- against, and the second signature that activated it.
  signature             text               CHECK (char_length(signature) <= 200),
  key_fingerprint       text               CHECK (char_length(key_fingerprint) <= 100),
  activation_signature  text               CHECK (char_length(activation_signature) <= 200),
  -- The agent asked for it to be forgotten; the person decides.
  forget_requested_at   timestamptz,
  forget_reason         text               CHECK (char_length(forget_reason) <= 500),
  -- Consolidation's flag: a likely contradiction with another memory.
  flagged_with          ulid,
  -- For recall. The embedder's signature travels with the vector, so vectors
  -- of different embedders are never compared.
  embedding             vector(1536),
  embedding_model       text               CHECK (char_length(embedding_model) <= 120),
  created_at            timestamptz        NOT NULL DEFAULT clock_timestamp(),
  updated_at            timestamptz        NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id) REFERENCES members (organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, id),
  CONSTRAINT memory_items_scope_ref CHECK ((scope = 'user') = (scope_ref IS NULL)),
  CONSTRAINT memory_items_operator CHECK (
    (tier = 'T0') = (source_kind = 'operator')
    AND (tier = 'T0') = (member_id IS NULL)
    AND (tier <> 'T0' OR (signature IS NOT NULL AND key_fingerprint IS NOT NULL))),
  CONSTRAINT memory_items_embedding CHECK ((embedding IS NULL) = (embedding_model IS NULL))
);

CREATE INDEX memory_items_member_idx ON memory_items (organization_id, member_id, state, created_at DESC);
CREATE INDEX memory_items_source_idx ON memory_items (organization_id, source_uri) WHERE source_uri IS NOT NULL;
CREATE INDEX memory_items_due_idx ON memory_items (state, expires_at) WHERE expires_at IS NOT NULL;
-- Recall reads active memory only; the index holds only what recall reads.
CREATE INDEX memory_items_embedding_idx ON memory_items
  USING hnsw (embedding vector_cosine_ops) WHERE state = 'active';

CREATE TRIGGER memory_items_updated_at BEFORE UPDATE ON memory_items
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- The least trusted tier a source may claim: a lower number is more trusted.
CREATE OR REPLACE FUNCTION app.memory_tier_floor(kind memory_source_kind) RETURNS memory_tier
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE kind
    WHEN 'operator'       THEN 'T0'::memory_tier
    WHEN 'user_direct'    THEN 'T1'::memory_tier
    WHEN 'agent_observed' THEN 'T2'::memory_tier
    WHEN 'third_party'    THEN 'T3'::memory_tier
    ELSE 'T4'::memory_tier
  END
$$;

-- Nothing is written straight into memory: a candidate starts pending, an
-- operator's signed claim starts staged. And no source claims more trust than
-- it has — the gap that let a model call its own words the person's (T1
-- laundering) is closed here, not only in the service.
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
  RETURN NEW;
END;
$$;

CREATE TRIGGER memory_items_insert BEFORE INSERT ON memory_items
  FOR EACH ROW EXECUTE FUNCTION app.guard_memory_insert();

-- The lifecycle (F2 §1.2), the sealed provenance, and the promotion rules.
CREATE OR REPLACE FUNCTION app.guard_memory_update() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  confirmations integer;
BEGIN
  IF (NEW.organization_id, NEW.member_id, NEW.scope, NEW.scope_ref, NEW.content, NEW.tier, NEW.source_kind,
      NEW.source_uri, NEW.conversation_id, NEW.run_id, NEW.actor, NEW.evidence_hash, NEW.sensitivity,
      NEW.signature, NEW.key_fingerprint, NEW.created_at)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.member_id, OLD.scope, OLD.scope_ref, OLD.content, OLD.tier, OLD.source_kind,
      OLD.source_uri, OLD.conversation_id, OLD.run_id, OLD.actor, OLD.evidence_hash, OLD.sensitivity,
      OLD.signature, OLD.key_fingerprint, OLD.created_at) THEN
    RAISE EXCEPTION 'memory %: content and provenance are sealed', OLD.id
      USING ERRCODE = 'check_violation', HINT = 'memory_provenance_immutable';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
         (OLD.state = 'pending'   AND NEW.state IN ('active', 'rejected', 'revoked', 'expired'))
      OR (OLD.state = 'active'    AND NEW.state IN ('demoted', 'revoked', 'expired'))
      OR (OLD.state = 'demoted'   AND NEW.state IN ('active', 'revoked', 'expired', 'rejected'))
      OR (OLD.state = 't0_staged' AND NEW.state IN ('active', 'revoked'))
    ) THEN
      RAISE EXCEPTION 'memory %: % cannot become %', OLD.id, OLD.state, NEW.state
        USING ERRCODE = 'check_violation', HINT = 'memory_transition_invalid';
    END IF;

    IF NEW.state = 'active' THEN
      -- A third-party claim needs two confirmations from independent evidence.
      IF OLD.state = 'pending' AND OLD.tier = 'T3' AND NEW.approved_at IS NULL THEN
        SELECT count(*) INTO confirmations FROM memory_confirmations c WHERE c.item_id = OLD.id;
        IF confirmations < 2 THEN
          RAISE EXCEPTION 'memory %: a third-party claim needs two independent confirmations (has %)', OLD.id, confirmations
            USING ERRCODE = 'check_violation', HINT = 'memory_confirmations_required';
        END IF;
      END IF;
      -- An unknown or subagent claim is promoted by the person, or not at all.
      IF OLD.state = 'pending' AND OLD.tier = 'T4' AND NEW.approved_at IS NULL THEN
        RAISE EXCEPTION 'memory %: only the person can approve this claim', OLD.id
          USING ERRCODE = 'check_violation', HINT = 'memory_approval_required';
      END IF;
      -- A demoted memory returns on new evidence only — a reaffirmation or a
      -- confirmation since the demotion — and under a lower ceiling than before.
      IF OLD.state = 'demoted' THEN
        IF NOT (
             (NEW.last_reaffirmed_at IS NOT NULL AND NEW.last_reaffirmed_at > OLD.demoted_at
              AND NEW.reaffirm_count > OLD.reaffirm_count)
          OR EXISTS (SELECT 1 FROM memory_confirmations c WHERE c.item_id = OLD.id AND c.created_at > OLD.demoted_at)
        ) OR NEW.trust_ceiling >= OLD.trust_ceiling THEN
          RAISE EXCEPTION 'memory %: a demoted memory returns only on new evidence, at a lower ceiling', OLD.id
            USING ERRCODE = 'check_violation', HINT = 'memory_repromotion_requires_evidence';
        END IF;
      END IF;
      -- An operator's claim is activated by a second signature, after its review gap.
      IF OLD.state = 't0_staged' AND (NEW.activation_signature IS NULL OR clock_timestamp() - OLD.created_at < interval '300 seconds') THEN
        RAISE EXCEPTION 'memory %: an operator claim is activated by a second signature, five minutes after staging', OLD.id
          USING ERRCODE = 'check_violation', HINT = 'memory_t0_review';
      END IF;
      NEW.verified_at := COALESCE(NEW.verified_at, clock_timestamp());
    END IF;
    IF NEW.state = 'demoted' THEN
      NEW.demoted_at := clock_timestamp();
    END IF;
  ELSIF OLD.state IN ('rejected', 'revoked', 'expired')
        AND (NEW.trust_ceiling, NEW.reaffirm_count, NEW.approved_at, NEW.expires_at)
            IS DISTINCT FROM (OLD.trust_ceiling, OLD.reaffirm_count, OLD.approved_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'memory % is %; it does not change any more', OLD.id, OLD.state
      USING ERRCODE = 'check_violation', HINT = 'memory_transition_invalid';
  END IF;

  -- Trust is restored by an explicit reaffirmation and only ever as far as it
  -- was; a reaffirmation counts up, never down.
  IF NEW.reaffirm_count < OLD.reaffirm_count THEN
    RAISE EXCEPTION 'memory %: reaffirmations only count up', OLD.id
      USING ERRCODE = 'check_violation', HINT = 'memory_transition_invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER memory_items_update BEFORE UPDATE ON memory_items
  FOR EACH ROW EXECUTE FUNCTION app.guard_memory_update();

-- ─────────────────────────────────────────────────────────── confirmations
-- Independent evidence for a claim: a different evidence hash, from a
-- different source than the claim itself and than every earlier confirmation.
-- Processing the same claim twice is not a confirmation (Agent 5.5's gap).
CREATE TABLE memory_confirmations (
  id              ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid        NOT NULL,
  item_id         ulid        NOT NULL,
  evidence_hash   text        NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  source_kind     memory_source_kind NOT NULL,
  source_uri      text        CHECK (char_length(source_uri) BETWEEN 1 AND 2000),
  run_id          ulid,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, item_id) REFERENCES memory_items (organization_id, id) ON DELETE CASCADE,
  UNIQUE (item_id, evidence_hash),
  CONSTRAINT memory_confirmations_source_once UNIQUE NULLS NOT DISTINCT (item_id, source_uri)
);

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
  RETURN NEW;
END;
$$;

CREATE TRIGGER memory_confirmations_guard BEFORE INSERT ON memory_confirmations
  FOR EACH ROW EXECUTE FUNCTION app.guard_memory_confirmation();

-- ───────────────────────────────────────────────────────────── derivations
-- What a memory came from: an outside source its run read, or an earlier
-- memory it was built on. Revoking a source follows these edges all the way.
CREATE TABLE memory_derivations (
  id              ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid        NOT NULL,
  item_id         ulid        NOT NULL,
  parent_item_id  ulid,
  source_uri      text        CHECK (char_length(source_uri) BETWEEN 1 AND 2000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, item_id) REFERENCES memory_items (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, parent_item_id) REFERENCES memory_items (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT memory_derivations_one CHECK ((parent_item_id IS NULL) <> (source_uri IS NULL)),
  CONSTRAINT memory_derivations_not_self CHECK (parent_item_id IS DISTINCT FROM item_id),
  CONSTRAINT memory_derivations_once UNIQUE NULLS NOT DISTINCT (item_id, parent_item_id, source_uri)
);

CREATE INDEX memory_derivations_parent_idx ON memory_derivations (parent_item_id) WHERE parent_item_id IS NOT NULL;
CREATE INDEX memory_derivations_source_idx ON memory_derivations (organization_id, source_uri) WHERE source_uri IS NOT NULL;

-- ──────────────────────────────────────────────────────────────── negative
-- What was rejected and why, so the same idea in other words is caught.
CREATE TABLE memory_negative (
  id              ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  member_id       ulid,
  item_id         ulid,
  content         text        NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),
  reason          text        NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  source_uri      text        CHECK (char_length(source_uri) BETWEEN 1 AND 2000),
  embedding       vector(1536),
  embedding_model text        CHECK (char_length(embedding_model) <= 120),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id) REFERENCES members (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT memory_negative_embedding CHECK ((embedding IS NULL) = (embedding_model IS NULL))
);

CREATE INDEX memory_negative_member_idx ON memory_negative (organization_id, member_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────── run taint
-- The outside sources an agent turn read: an attachment, later a web page, a
-- mail, a channel message, another agent's output. A memory proposed in that
-- turn is derived from them and can be no more trusted than they are (D-12).
CREATE TABLE run_taint (
  id              ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid        NOT NULL,
  member_id       ulid        NOT NULL,
  conversation_id ulid        NOT NULL,
  run_id          ulid        NOT NULL,
  source_kind     memory_source_kind NOT NULL CHECK (source_kind IN ('third_party', 'subagent', 'unknown')),
  source_uri      text        NOT NULL CHECK (char_length(source_uri) BETWEEN 1 AND 2000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, member_id, conversation_id)
    REFERENCES agent_conversations (organization_id, member_id, id) ON DELETE CASCADE,
  CONSTRAINT run_taint_once UNIQUE (run_id, source_uri)
);

-- ────────────────────────────────────────────────────────────────── ledger
-- Every write and transition, chained: each entry's hash covers the one
-- before it, so changing or removing any line breaks every hash after it.
-- One chain per organization, appended to by the triggers below — the only
-- way in — under an advisory lock, so two writers never fork it.
CREATE TABLE memory_ledger (
  id              ulid        PRIMARY KEY DEFAULT app.generate_ulid(),
  organization_id ulid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  seq             bigint      NOT NULL CHECK (seq >= 1),
  prev_hash       text        NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  entry_hash      text        NOT NULL CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
  action          text        NOT NULL CHECK (action ~ '^[a-z0-9_]{1,40}$'),
  item_id         ulid,
  detail          jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, seq)
);

CREATE INDEX memory_ledger_item_idx ON memory_ledger (organization_id, item_id, seq);

-- The text a ledger entry's hash is taken over: the previous hash, then the
-- entry's own fields in a fixed order (jsonb's text is already canonical).
CREATE OR REPLACE FUNCTION app.memory_ledger_body(
  prev text, seq bigint, action text, item ulid, detail jsonb, at timestamptz
) RETURNS text
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT prev || '|' || seq::text || '|' || action || '|' || COALESCE(item::text, '') || '|' || detail::text || '|'
         || to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

-- Appends one entry to the organization's chain. SECURITY DEFINER: the
-- application role cannot insert into the ledger itself, only cause entries
-- through the memory it may change — and row-level security still holds, so
-- an entry lands only in the chain of the organization in scope.
CREATE OR REPLACE FUNCTION app.memory_ledger_append(p_org ulid, p_action text, p_item ulid, p_detail jsonb)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, app, pg_temp
AS $$
DECLARE
  head  memory_ledger%ROWTYPE;
  n     bigint;
  prev  text;
  at    timestamptz := clock_timestamp();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('memory_ledger:' || p_org::text, 0));
  SELECT * INTO head FROM memory_ledger WHERE organization_id = p_org ORDER BY seq DESC LIMIT 1;
  n := COALESCE(head.seq, 0) + 1;
  prev := COALESCE(head.entry_hash, repeat('0', 64));
  INSERT INTO memory_ledger (organization_id, seq, prev_hash, entry_hash, action, item_id, detail, created_at)
  VALUES (p_org, n, prev,
          encode(digest(app.memory_ledger_body(prev, n, p_action, p_item, p_detail, at), 'sha256'), 'hex'),
          p_action, p_item, p_detail, at);
END;
$$;

-- Recomputes the chain of the organization in scope. Answers the first entry
-- that does not hold, or nothing when the whole chain does.
CREATE OR REPLACE FUNCTION app.memory_ledger_verify()
  RETURNS TABLE (broken_seq bigint, checked bigint)
  LANGUAGE plpgsql STABLE
AS $$
DECLARE
  entry memory_ledger%ROWTYPE;
  prev  text := repeat('0', 64);
  n     bigint := 0;
BEGIN
  FOR entry IN SELECT * FROM memory_ledger ORDER BY organization_id, seq LOOP
    n := n + 1;
    IF entry.seq <> n OR entry.prev_hash <> prev
       OR entry.entry_hash <> encode(digest(app.memory_ledger_body(prev, entry.seq, entry.action, entry.item_id,
                                                                   entry.detail, entry.created_at), 'sha256'), 'hex') THEN
      broken_seq := entry.seq;
      checked := n;
      RETURN NEXT;
      RETURN;
    END IF;
    prev := entry.entry_hash;
  END LOOP;
  broken_seq := NULL;
  checked := n;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION app.reject_memory_ledger_change() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = OLD.organization_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'the memory ledger is append-only (attempted %)', TG_OP
    USING ERRCODE = 'insufficient_privilege', HINT = 'memory_ledger_immutable';
END;
$$;

CREATE TRIGGER memory_ledger_no_update BEFORE UPDATE ON memory_ledger
  FOR EACH ROW EXECUTE FUNCTION app.reject_memory_ledger_change();
CREATE TRIGGER memory_ledger_no_delete BEFORE DELETE ON memory_ledger
  FOR EACH ROW EXECUTE FUNCTION app.reject_memory_ledger_change();

-- What lands in the ledger, written by the database for every caller. These
-- run as the schema owner, the only role that may call the append: the
-- application role causes entries by changing memory, and cannot write one.
CREATE OR REPLACE FUNCTION app.ledger_memory_change() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, app, pg_temp
AS $$
DECLARE
  act text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.memory_ledger_append(NEW.organization_id,
      CASE WHEN NEW.state = 't0_staged' THEN 't0_stage' ELSE 'ingest' END, NEW.id,
      jsonb_build_object('tier', NEW.tier, 'source', NEW.source_kind, 'uri', NEW.source_uri,
                         'evidence', NEW.evidence_hash, 'sensitivity', NEW.sensitivity));
    RETURN NEW;
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    act := CASE
      WHEN NEW.state = 'active' AND OLD.state = 't0_staged' THEN 't0_activate'
      WHEN NEW.state = 'active' AND OLD.state = 'demoted'   THEN 'repromote'
      WHEN NEW.state = 'active' AND NEW.approved_at IS NOT NULL AND OLD.approved_at IS NULL THEN 'approve'
      WHEN NEW.state = 'active'   THEN 'promote'
      WHEN NEW.state = 'rejected' THEN 'reject'
      WHEN NEW.state = 'revoked'  THEN 'revoke'
      WHEN NEW.state = 'expired'  THEN 'expire'
      WHEN NEW.state = 'demoted'  THEN 'demote'
    END;
    PERFORM app.memory_ledger_append(NEW.organization_id, act, NEW.id,
      jsonb_strip_nulls(jsonb_build_object('from', OLD.state, 'reason', NEW.state_reason, 'verdict', NEW.verdict,
                                           'ceiling', NEW.trust_ceiling)));
  ELSIF NEW.reaffirm_count > OLD.reaffirm_count THEN
    PERFORM app.memory_ledger_append(NEW.organization_id, 'reaffirm', NEW.id,
      jsonb_build_object('count', NEW.reaffirm_count, 'ceiling', NEW.trust_ceiling));
  END IF;
  IF NEW.forget_requested_at IS NOT NULL AND OLD.forget_requested_at IS NULL THEN
    PERFORM app.memory_ledger_append(NEW.organization_id, 'forget_request', NEW.id,
      jsonb_strip_nulls(jsonb_build_object('reason', NEW.forget_reason)));
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER memory_items_ledger AFTER INSERT OR UPDATE ON memory_items
  FOR EACH ROW EXECUTE FUNCTION app.ledger_memory_change();

CREATE OR REPLACE FUNCTION app.ledger_memory_confirmation() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, app, pg_temp
AS $$
BEGIN
  PERFORM app.memory_ledger_append(NEW.organization_id, 'confirm', NEW.item_id,
    jsonb_strip_nulls(jsonb_build_object('evidence', NEW.evidence_hash, 'source', NEW.source_kind, 'uri', NEW.source_uri)));
  RETURN NEW;
END;
$$;

CREATE TRIGGER memory_confirmations_ledger AFTER INSERT ON memory_confirmations
  FOR EACH ROW EXECUTE FUNCTION app.ledger_memory_confirmation();

-- ─────────────────────────────────────────────────────────── revocation
-- Everything that falls with a source: the memories from it, the memories
-- whose run read it, and — through the derivation edges, to any depth — every
-- memory built on those. In the caller's scope, by row-level security.
CREATE OR REPLACE FUNCTION app.memory_revocation_set(p_uri text, p_item ulid)
  RETURNS TABLE (id ulid)
  LANGUAGE sql STABLE
AS $$
  WITH RECURSIVE affected(id) AS (
    SELECT m.id FROM memory_items m WHERE m.source_uri = p_uri OR m.id = p_item
    UNION
    SELECT d.item_id FROM memory_derivations d WHERE d.source_uri = p_uri
    UNION
    SELECT d.item_id FROM memory_derivations d JOIN affected a ON d.parent_item_id = a.id
  )
  SELECT a.id FROM affected a JOIN memory_items m ON m.id = a.id
   WHERE m.state IN ('pending', 'active', 'demoted', 't0_staged')
$$;

-- ──────────────────────────────────────────────────────── row-level security
-- A person's memory is theirs: the policies name the member in scope as well
-- as the organization. An operator's T0 (no member) is read by everyone in the
-- organization it was signed for.
ALTER TABLE memory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_items FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memory_items
  USING      (organization_id = (SELECT app.current_organization_id())
              AND (member_id = (SELECT app.current_member_id()) OR member_id IS NULL))
  WITH CHECK (organization_id = (SELECT app.current_organization_id())
              AND (member_id = (SELECT app.current_member_id()) OR member_id IS NULL));

ALTER TABLE memory_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_confirmations FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memory_confirmations
  USING (organization_id = (SELECT app.current_organization_id())
         AND EXISTS (SELECT 1 FROM memory_items m WHERE m.id = memory_confirmations.item_id));

ALTER TABLE memory_derivations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_derivations FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memory_derivations
  USING (organization_id = (SELECT app.current_organization_id())
         AND EXISTS (SELECT 1 FROM memory_items m WHERE m.id = memory_derivations.item_id));

ALTER TABLE memory_negative ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_negative FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memory_negative
  USING (organization_id = (SELECT app.current_organization_id())
         AND (member_id = (SELECT app.current_member_id()) OR member_id IS NULL));

ALTER TABLE run_taint ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_taint FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON run_taint
  USING (organization_id = (SELECT app.current_organization_id())
         AND member_id = (SELECT app.current_member_id()));

ALTER TABLE memory_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_ledger FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memory_ledger
  USING (organization_id = (SELECT app.current_organization_id()));

-- ───────────────────────────────────────────────────────────────── grants
-- The application role proposes, moves memory along its lifecycle and reads;
-- it deletes nothing and writes the ledger only through the triggers. The
-- platform role reads, to find the organizations the nightly pass visits.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milyonuse_app') THEN
    REVOKE ALL ON memory_items, memory_confirmations, memory_derivations, memory_negative, run_taint, memory_ledger
      FROM milyonuse_app;
    GRANT SELECT, INSERT ON memory_items TO milyonuse_app;
    GRANT UPDATE (state, state_reason, verdict, verified_at, expires_at, approved_by, approved_at, trust_ceiling,
                  last_reaffirmed_at, reaffirm_count, activation_signature, forget_requested_at, forget_reason,
                  flagged_with, embedding, embedding_model, updated_at)
      ON memory_items TO milyonuse_app;
    GRANT SELECT, INSERT ON memory_confirmations, memory_derivations, memory_negative, run_taint TO milyonuse_app;
    GRANT SELECT ON memory_ledger TO milyonuse_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'milyonuse_platform') THEN
    REVOKE ALL ON memory_items, memory_confirmations, memory_derivations, memory_negative, run_taint, memory_ledger
      FROM milyonuse_platform;
    GRANT SELECT ON memory_items, memory_ledger TO milyonuse_platform;
  END IF;
END $$;

-- The append is the schema owner's alone; the default grants of 0001 are taken back.
DO $$
DECLARE
  role text;
BEGIN
  FOREACH role IN ARRAY ARRAY['PUBLIC', 'milyonuse_app', 'milyonuse_platform'] LOOP
    IF role = 'PUBLIC' OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.memory_ledger_append(ulid, text, ulid, jsonb) FROM %s', role);
      EXECUTE format('REVOKE ALL ON FUNCTION app.ledger_memory_change() FROM %s', role);
      EXECUTE format('REVOKE ALL ON FUNCTION app.ledger_memory_confirmation() FROM %s', role);
    END IF;
  END LOOP;
END $$;
