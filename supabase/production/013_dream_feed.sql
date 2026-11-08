-- Phase 6: short-lived bounded ranking windows. Apply after phase 5 votes.
BEGIN;
CREATE TABLE app.dream_feed_windows (
  id uuid PRIMARY KEY,
  viewer_key text NOT NULL CHECK(char_length(viewer_key)=64),
  cursor_key text NOT NULL CHECK(char_length(cursor_key)=64),
  ids uuid[] NOT NULL CHECK(cardinality(ids)<=48),
  more boolean NOT NULL,
  after_time timestamptz,
  after_id uuid,
  snapshot_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  next_window uuid,
  CHECK((after_time IS NULL)=(after_id IS NULL)),
  CHECK(expires_at>snapshot_at AND expires_at<=snapshot_at+interval '15 minutes')
);
CREATE INDEX dream_feed_window_expiry ON app.dream_feed_windows(expires_at);
CREATE INDEX dream_feed_window_viewer ON app.dream_feed_windows(viewer_key);
CREATE INDEX dream_votes_recent ON app.dream_votes(voter_id,updated_at DESC,dream_id DESC);
ALTER TABLE app.dream_feed_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.dream_feed_windows FROM PUBLIC;
DO $security$
DECLARE browser_role text;
BEGIN
  FOREACH browser_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=browser_role) THEN
      EXECUTE format('REVOKE ALL ON app.dream_feed_windows FROM %I',browser_role);
    END IF;
  END LOOP;
END
$security$;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.dream_feed_windows TO ambatu_prod_dream_writer;
CREATE POLICY prod_dream_feed ON app.dream_feed_windows FOR ALL TO ambatu_prod_dream_writer USING(true) WITH CHECK(true);
COMMIT;
