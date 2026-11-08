-- Phase 4. Apply after 017. Media stays disabled until worker/gateway are deployed.
BEGIN;
ALTER TABLE app.dreams DROP CONSTRAINT dreams_body_check;
ALTER TABLE app.dreams ADD COLUMN attachment_ids uuid[] NOT NULL DEFAULT '{}', ADD COLUMN pending_edit jsonb;
ALTER TABLE app.dreams ADD CONSTRAINT dream_body_media CHECK (char_length(body)<=2000 AND
  (body ~ '[^[:space:]]' OR cardinality(attachment_ids)>0 OR pending_edit IS NOT NULL));
ALTER TABLE app.dreams ADD CONSTRAINT dream_attachment_limit CHECK (cardinality(attachment_ids)<=25);
CREATE TABLE app.dream_attachments (
  id uuid PRIMARY KEY, owner_id text NOT NULL, dream_id uuid REFERENCES app.dreams(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('image','video')), content_type text NOT NULL,
  declared_bytes bigint NOT NULL CHECK(declared_bytes>0 AND declared_bytes<=209715200),
  state text NOT NULL DEFAULT 'awaiting_upload' CHECK(state IN ('awaiting_upload','processing','ready','failed','cancelled')),
  input_key text NOT NULL UNIQUE, input_received boolean NOT NULL DEFAULT false, output_prefix text, generation uuid, lease_until timestamptz,
  output_bytes bigint, width integer, height integer, duration double precision, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  upload_expires_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0,
  CHECK((kind='image' AND content_type IN ('image/jpeg','image/png') AND declared_bytes<=10485760)
     OR (kind='video' AND content_type='video/mp4'))
);
CREATE INDEX dream_attachment_owner ON app.dream_attachments(owner_id,created_at DESC);
CREATE INDEX dream_attachment_parent ON app.dream_attachments(dream_id);
CREATE INDEX dream_attachment_abandoned ON app.dream_attachments(created_at,owner_id) WHERE dream_id IS NULL;
CREATE INDEX dream_attachment_pending_owner ON app.dream_attachments(owner_id) WHERE dream_id IS NULL OR state IN ('awaiting_upload','processing');
CREATE INDEX dream_attachment_work ON app.dream_attachments(state,updated_at) WHERE state IN ('awaiting_upload','processing');
CREATE TABLE app.dream_media_sessions (
  token_hash text PRIMARY KEY, viewer_id text, dream_id uuid NOT NULL REFERENCES app.dreams(id) ON DELETE CASCADE,
  attachment_ids uuid[] NOT NULL CHECK(cardinality(attachment_ids)<=25), expires_at timestamptz NOT NULL
);
CREATE INDEX dream_media_session_expiry ON app.dream_media_sessions(expires_at);
CREATE TABLE app.dream_media_jobs (
  id uuid PRIMARY KEY,owner_id text NOT NULL,attachment_ids uuid[] NOT NULL,prefixes text[] NOT NULL,
  dream_ids uuid[] NOT NULL DEFAULT '{}',depends_on uuid[] NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete')),
  error_code text,created_at timestamptz NOT NULL DEFAULT now(),not_before timestamptz NOT NULL,
  last_swept_at timestamptz
);
CREATE INDEX dream_media_cleanup_due ON app.dream_media_jobs(last_swept_at NULLS FIRST) WHERE state='pending';
CREATE INDEX dream_media_cleanup_owner ON app.dream_media_jobs(owner_id,created_at) WHERE state='pending';
CREATE TABLE app.dream_upload_budgets (
  owner_id text PRIMARY KEY,window_started timestamptz NOT NULL DEFAULT now(),
  requests integer NOT NULL DEFAULT 0 CHECK(requests>=0),bytes bigint NOT NULL DEFAULT 0 CHECK(bytes>=0)
);
ALTER TABLE app.dream_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dream_media_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dream_media_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dream_upload_budgets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.dream_upload_budgets FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.dream_upload_budgets TO ambatu_dev_dream_writer;
CREATE POLICY dev_dream_upload_budgets ON app.dream_upload_budgets FOR ALL TO ambatu_dev_dream_writer USING(true) WITH CHECK(true);
CREATE ROLE ambatu_dev_dream_worker LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE ambatu_dev_dream_media_reader LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA app TO ambatu_dev_dream_worker,ambatu_dev_dream_media_reader;
GRANT SELECT (id,source_project) ON app.migration_runs TO ambatu_dev_dream_media_reader;
CREATE POLICY dev_dream_media_marker ON app.migration_runs FOR SELECT TO ambatu_dev_dream_media_reader USING(true);
DO $security$
DECLARE target text; browser_role text;
BEGIN
  FOREACH target IN ARRAY ARRAY['dream_attachments','dream_media_sessions','dream_media_jobs','dream_upload_budgets'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC',target);
    FOREACH browser_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=browser_role) THEN EXECUTE format('REVOKE ALL ON app.%I FROM %I',target,browser_role); END IF;
    END LOOP;
    IF target<>'dream_upload_budgets' THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON app.%I TO ambatu_dev_dream_writer,ambatu_dev_dream_worker',target);
      EXECUTE format('CREATE POLICY dev_dream_media_write ON app.%I FOR ALL TO ambatu_dev_dream_writer,ambatu_dev_dream_worker USING(true) WITH CHECK(true)',target);
    END IF;
  END LOOP;
  FOREACH target IN ARRAY ARRAY['dreams'] LOOP
    EXECUTE format('GRANT SELECT,UPDATE ON app.%I TO ambatu_dev_dream_worker',target);
    EXECUTE format('CREATE POLICY dev_dream_worker ON app.%I FOR ALL TO ambatu_dev_dream_worker USING(true) WITH CHECK(true)',target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['dreams','dream_attachments','dream_media_sessions','player_deletions','friendships','player_blocks'] LOOP
    EXECUTE format('GRANT SELECT ON app.%I TO ambatu_dev_dream_media_reader',target);
    EXECUTE format('CREATE POLICY dev_dream_media_read ON app.%I FOR SELECT TO ambatu_dev_dream_media_reader USING(true)',target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['player_deletions','migration_runs'] LOOP
    EXECUTE format('GRANT SELECT ON app.%I TO ambatu_dev_dream_worker',target);
    EXECUTE format('CREATE POLICY dev_dream_worker_read ON app.%I FOR SELECT TO ambatu_dev_dream_worker USING(true)',target);
  END LOOP;
END $security$;
COMMIT;
