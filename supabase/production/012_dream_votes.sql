-- Phase 5: private vote state, retry receipts and counters. Apply after phase 4 budget migration.
BEGIN;
ALTER TABLE app.dreams
  ADD COLUMN buss_up_count integer NOT NULL DEFAULT 0 CHECK(buss_up_count>=0),
  ADD COLUMN buss_down_count integer NOT NULL DEFAULT 0 CHECK(buss_down_count>=0);
CREATE TABLE app.dream_votes (
  dream_id uuid NOT NULL REFERENCES app.dreams(id) ON DELETE CASCADE,
  voter_id text NOT NULL,
  value smallint NOT NULL CHECK(value IN (-1,1)),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(dream_id,voter_id)
);
CREATE INDEX dream_votes_voter ON app.dream_votes(voter_id,dream_id);
CREATE TABLE app.dream_vote_requests (
  dream_id uuid NOT NULL REFERENCES app.dreams(id) ON DELETE CASCADE,
  voter_id text NOT NULL,
  request_key text NOT NULL CHECK(char_length(request_key) BETWEEN 8 AND 128),
  value smallint NOT NULL CHECK(value IN (-1,0,1)),
  PRIMARY KEY(dream_id,voter_id,request_key)
);
CREATE INDEX dream_vote_requests_voter ON app.dream_vote_requests(voter_id);
CREATE TABLE app.dream_vote_budgets (
  voter_id text PRIMARY KEY,
  minute_started timestamptz NOT NULL DEFAULT now(),
  minute_requests integer NOT NULL DEFAULT 1 CHECK(minute_requests>=1),
  day_started timestamptz NOT NULL DEFAULT now(),
  day_requests integer NOT NULL DEFAULT 1 CHECK(day_requests>=1)
);
-- Invoker privileges only. Every mutation, including voter cleanup, updates the parent atomically.
CREATE FUNCTION app.dream_vote_count_change() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,app AS $function$
DECLARE up_delta integer := 0; down_delta integer := 0; target uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN
    target := OLD.dream_id;
    up_delta := up_delta - CASE WHEN OLD.value=1 THEN 1 ELSE 0 END;
    down_delta := down_delta - CASE WHEN OLD.value=-1 THEN 1 ELSE 0 END;
  END IF;
  IF TG_OP<>'DELETE' THEN
    target := NEW.dream_id;
    up_delta := up_delta + CASE WHEN NEW.value=1 THEN 1 ELSE 0 END;
    down_delta := down_delta + CASE WHEN NEW.value=-1 THEN 1 ELSE 0 END;
  END IF;
  UPDATE app.dreams SET buss_up_count=buss_up_count+up_delta,buss_down_count=buss_down_count+down_delta WHERE id=target;
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION app.dream_vote_count_change() FROM PUBLIC;
CREATE TRIGGER dream_vote_counts AFTER INSERT OR UPDATE OR DELETE ON app.dream_votes
FOR EACH ROW EXECUTE FUNCTION app.dream_vote_count_change();
DO $security$
DECLARE target text; browser_role text;
BEGIN
  FOREACH target IN ARRAY ARRAY['dream_votes','dream_vote_requests','dream_vote_budgets'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC',target);
    FOREACH browser_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=browser_role) THEN
        EXECUTE format('REVOKE ALL ON app.%I FROM %I',target,browser_role);
      END IF;
    END LOOP;
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON app.%I TO ambatu_prod_dream_writer',target);
    EXECUTE format('CREATE POLICY prod_dream_votes ON app.%I FOR ALL TO ambatu_prod_dream_writer USING(true) WITH CHECK(true)',target);
  END LOOP;
END
$security$;
GRANT EXECUTE ON FUNCTION app.dream_vote_count_change() TO ambatu_prod_dream_writer;
-- Default privileges may have been customized on the host; revoke browser function access explicitly.
DO $functions$
DECLARE browser_role text;
BEGIN
  FOREACH browser_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=browser_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.dream_vote_count_change() FROM %I',browser_role);
    END IF;
  END LOOP;
END
$functions$;
COMMIT;
