-- Phase 3: text Dreams. Apply after player_blocks; keep the module flag off.
BEGIN;
CREATE TABLE app.player_deletions (
  player_id text PRIMARY KEY,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','complete')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.dreams (
  id uuid PRIMARY KEY,
  author_id text NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000 AND body ~ '[^[:space:]]'),
  audience text NOT NULL DEFAULT 'public' CHECK (audience IN ('public','friends','only_me')),
  publication text NOT NULL DEFAULT 'draft' CHECK (publication IN ('draft','processing','published','failed')),
  moderation text NOT NULL DEFAULT 'visible' CHECK (moderation IN ('visible','removed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CHECK (publication <> 'published' OR published_at IS NOT NULL)
);
CREATE INDEX dream_author_history ON app.dreams (author_id,created_at DESC,id DESC);
CREATE INDEX dream_public_candidates ON app.dreams (published_at DESC,id DESC) WHERE publication='published' AND moderation='visible';
CREATE TABLE app.dream_requests (
  author_id text NOT NULL,
  request_key text NOT NULL CHECK (char_length(request_key) BETWEEN 8 AND 128),
  request_hash text,
  dream_id uuid REFERENCES app.dreams(id),
  PRIMARY KEY (author_id,request_key),
  CHECK ((dream_id IS NULL AND request_hash IS NULL) OR (dream_id IS NOT NULL AND request_hash IS NOT NULL))
);
CREATE INDEX dream_request_resource ON app.dream_requests (dream_id) WHERE dream_id IS NOT NULL;
DO $security$
DECLARE target text; role_name text;
BEGIN
  FOREACH target IN ARRAY ARRAY['dreams','dream_requests','player_deletions'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC',target);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON app.%I FROM %I',target,role_name);
      END IF;
    END LOOP;
  END LOOP;
END
$security$;
CREATE ROLE ambatu_dev_dream_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT ambatu_dev_dream_writer TO ambatu_dev_content_reader;
GRANT USAGE ON SCHEMA app TO ambatu_dev_dream_writer;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.dreams,app.dream_requests,app.player_deletions TO ambatu_dev_dream_writer;
CREATE POLICY dev_dream_rows ON app.dreams FOR ALL TO ambatu_dev_dream_writer USING (true) WITH CHECK (true);
CREATE POLICY dev_dream_requests ON app.dream_requests FOR ALL TO ambatu_dev_dream_writer USING (true) WITH CHECK (true);
CREATE POLICY dev_dream_deletions ON app.player_deletions FOR ALL TO ambatu_dev_dream_writer USING (true) WITH CHECK (true);
GRANT SELECT ON app.friendships,app.player_blocks TO ambatu_dev_dream_writer;
CREATE POLICY dev_dream_friendships ON app.friendships FOR SELECT TO ambatu_dev_dream_writer USING (true);
CREATE POLICY dev_dream_blocks ON app.player_blocks FOR SELECT TO ambatu_dev_dream_writer USING (true);
GRANT SELECT (id,username) ON app.player_profiles TO ambatu_dev_dream_writer;
CREATE POLICY dev_dream_profiles ON app.player_profiles FOR SELECT TO ambatu_dev_dream_writer USING (true);
COMMIT;
