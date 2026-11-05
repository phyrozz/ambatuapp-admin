-- Apply before deploying the personalized Ambatuscroll API.
BEGIN;
CREATE TABLE app.scroll_preferences (
  player_id text PRIMARY KEY,
  history jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(history) = 'array' AND jsonb_array_length(history) <= 100),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.scroll_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.scroll_preferences FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.scroll_preferences TO ambatu_prod_video_writer;
CREATE POLICY prod_scroll_preferences ON app.scroll_preferences FOR ALL TO ambatu_prod_video_writer USING (true) WITH CHECK (true);
CREATE INDEX scroll_recent_votes ON app.content_votes (voter_key,content_kind,updated_at DESC NULLS LAST,content_id) WHERE value<>0;
COMMIT;
