-- One society name, one live society.
-- Public sign-up never checked names, so the same cooperative could be registered repeatedly under different phone
-- numbers (seen in production: two "Doyincoop" trials seven minutes apart). The rule now lives in the database.
--
-- coop_society_name_key() reduces a name to a comparable key: case, punctuation, spacing and filler words (cooperative,
-- coop, society, ltd, thrift, credit, union, association, and, the) are ignored, so "Doyin Coop", "Doyincoop" and
-- "DOYIN CO-OPERATIVE SOCIETY LTD" are one name, while "Doyin Coop Ikeja" is a different one. A trigger keeps coop_societies.name_key
-- current, and a unique index over it (live societies only - an archived/expired trial releases its name) enforces it
-- for EVERY path that creates a society, including ones written later.
--
-- PRODUCTION ONLY, run first: the one existing duplicate had to be dealt with before the index could be built. The empty
-- copy of "Doyincoop" (COOPSOC-08E5F5B9: no members, loans, transactions or staff) was archived using the same mechanism the
-- nightly job applies to an ended trial (its trial was due to end that day anyway). Reversible: set archived_at back to NULL.
--   UPDATE coop_societies SET subscription_status='trial_expired', archived_at=now(), archive_reason='Duplicate registration ...'
--   WHERE coop_id='COOPSOC-08E5F5B9' AND <still empty>;
-- Applied to staging, then production; enforcement proven on both with a rolled-back dry run.

CREATE OR REPLACE FUNCTION coop_society_name_key(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  WITH a AS (SELECT regexp_replace(replace(lower(coalesce(p,'')), '&', ' and '), '[^a-z0-9]+', ' ', 'g') AS spaced),
  b AS (SELECT spaced, regexp_replace(regexp_replace(spaced, '\m(co operative|cooperative|coop|society|societies|ltd|limited|multi purpose|multipurpose|thrift|credit|union|association|and|the)\M', ' ', 'g'), ' ', '', 'g') AS clean FROM a),
  c AS (SELECT spaced, clean, regexp_replace(clean, '(cooperative|coop|society|societies|ltd|limited|multipurpose|thrift|credit|union|association)+$', '') AS tail_stripped FROM b)
  SELECT CASE WHEN length(tail_stripped) >= 3 THEN tail_stripped
              WHEN length(clean) >= 3 THEN clean
              ELSE regexp_replace(spaced, ' ', '', 'g') END
  FROM c
$$;
REVOKE ALL ON FUNCTION coop_society_name_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION coop_society_name_key(text) TO service_role;

ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS name_key text;
CREATE OR REPLACE FUNCTION coop_societies_set_name_key() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.name_key := coop_society_name_key(NEW.name); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS trg_coop_societies_name_key ON coop_societies;
CREATE TRIGGER trg_coop_societies_name_key BEFORE INSERT OR UPDATE OF name ON coop_societies FOR EACH ROW EXECUTE FUNCTION coop_societies_set_name_key();
UPDATE coop_societies SET name_key = coop_society_name_key(name) WHERE name_key IS DISTINCT FROM coop_society_name_key(name);
CREATE UNIQUE INDEX IF NOT EXISTS coop_societies_name_key_unique ON coop_societies (name_key) WHERE archived_at IS NULL;
