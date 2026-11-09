-- Phase 6.5. Apply after 014. Private server-only comments, replies and votes.
BEGIN;
CREATE TABLE app.dream_comments (
  id uuid PRIMARY KEY,
  dream_id uuid NOT NULL REFERENCES app.dreams(id) ON DELETE CASCADE,
  parent_id uuid,
  author_id text,
  body text,
  moderation text NOT NULL DEFAULT 'visible' CHECK(moderation IN ('visible','removed')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>=1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  buss_up_count integer NOT NULL DEFAULT 0 CHECK(buss_up_count>=0),
  buss_down_count integer NOT NULL DEFAULT 0 CHECK(buss_down_count>=0),
  UNIQUE(dream_id,id),
  FOREIGN KEY(dream_id,parent_id) REFERENCES app.dream_comments(dream_id,id) ON DELETE CASCADE,
  CHECK(parent_id IS DISTINCT FROM id),
  CHECK((deleted_at IS NULL AND author_id IS NOT NULL AND body IS NOT NULL AND char_length(body) BETWEEN 1 AND 2000 AND length(btrim(body))>0)
     OR (deleted_at IS NOT NULL AND author_id IS NULL AND body IS NULL))
);
CREATE INDEX dream_comments_thread ON app.dream_comments(dream_id,parent_id,created_at DESC,id DESC);
CREATE INDEX dream_comments_author ON app.dream_comments(author_id,dream_id) WHERE author_id IS NOT NULL;
CREATE TABLE app.dream_comment_requests (
  dream_id uuid NOT NULL REFERENCES app.dreams(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  request_key text NOT NULL CHECK(char_length(request_key) BETWEEN 8 AND 128),
  request_hash text,
  comment_id uuid REFERENCES app.dream_comments(id) ON DELETE SET NULL,
  PRIMARY KEY(dream_id,actor_id,request_key)
);
CREATE INDEX dream_comment_requests_actor ON app.dream_comment_requests(actor_id);
CREATE INDEX dream_comment_requests_comment ON app.dream_comment_requests(comment_id);
CREATE TABLE app.dream_comment_votes (
  comment_id uuid NOT NULL REFERENCES app.dream_comments(id) ON DELETE CASCADE,
  voter_id text NOT NULL,
  value smallint NOT NULL CHECK(value IN (-1,1)),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(comment_id,voter_id)
);
CREATE INDEX dream_comment_votes_voter ON app.dream_comment_votes(voter_id,comment_id);
CREATE TABLE app.dream_comment_vote_requests (
  comment_id uuid NOT NULL REFERENCES app.dream_comments(id) ON DELETE CASCADE,
  voter_id text NOT NULL,
  request_key text NOT NULL CHECK(char_length(request_key) BETWEEN 8 AND 128),
  value smallint NOT NULL CHECK(value IN (-1,0,1)),
  PRIMARY KEY(comment_id,voter_id,request_key)
);
CREATE INDEX dream_comment_vote_requests_voter ON app.dream_comment_vote_requests(voter_id);
CREATE TABLE app.dream_comment_budgets (
  actor_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('write','vote')),
  minute_started timestamptz NOT NULL DEFAULT now(),
  minute_requests integer NOT NULL DEFAULT 1 CHECK(minute_requests>=1),
  day_started timestamptz NOT NULL DEFAULT now(),
  day_requests integer NOT NULL DEFAULT 1 CHECK(day_requests>=1),
  PRIMARY KEY(actor_id,kind)
);
CREATE FUNCTION app.dream_comment_vote_count_change() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,app AS $function$
DECLARE up_delta integer := 0; down_delta integer := 0; target uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN
    target := OLD.comment_id;
    up_delta := up_delta - CASE WHEN OLD.value=1 THEN 1 ELSE 0 END;
    down_delta := down_delta - CASE WHEN OLD.value=-1 THEN 1 ELSE 0 END;
  END IF;
  IF TG_OP<>'DELETE' THEN
    target := NEW.comment_id;
    up_delta := up_delta + CASE WHEN NEW.value=1 THEN 1 ELSE 0 END;
    down_delta := down_delta + CASE WHEN NEW.value=-1 THEN 1 ELSE 0 END;
  END IF;
  UPDATE app.dream_comments SET buss_up_count=buss_up_count+up_delta,buss_down_count=buss_down_count+down_delta WHERE id=target;
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION app.dream_comment_vote_count_change() FROM PUBLIC;
CREATE TRIGGER dream_comment_vote_counts AFTER INSERT OR UPDATE OR DELETE ON app.dream_comment_votes
FOR EACH ROW EXECUTE FUNCTION app.dream_comment_vote_count_change();
DO $security$
DECLARE target text; browser_role text;
BEGIN
  FOREACH target IN ARRAY ARRAY['dream_comments','dream_comment_requests','dream_comment_votes','dream_comment_vote_requests','dream_comment_budgets'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC',target);
    FOREACH browser_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=browser_role) THEN
        EXECUTE format('REVOKE ALL ON app.%I FROM %I',target,browser_role);
      END IF;
    END LOOP;
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON app.%I TO ambatu_prod_dream_writer',target);
    EXECUTE format('CREATE POLICY prod_dream_comments ON app.%I FOR ALL TO ambatu_prod_dream_writer USING(true) WITH CHECK(true)',target);
  END LOOP;
  FOREACH browser_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=browser_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app.dream_comment_vote_count_change() FROM %I',browser_role);
    END IF;
  END LOOP;
END
$security$;
GRANT EXECUTE ON FUNCTION app.dream_comment_vote_count_change() TO ambatu_prod_dream_writer;
COMMIT;

