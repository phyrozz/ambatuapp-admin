-- Apply before deploying the Scroll ads feature.
BEGIN;
CREATE TABLE app.scroll_ads (
 id text PRIMARY KEY, title text NOT NULL, image_url text NOT NULL, destination_url text NOT NULL,
 active boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.scroll_ads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.scroll_ads FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.scroll_ads TO ambatu_dev_video_writer;
CREATE POLICY dev_scroll_ads ON app.scroll_ads FOR ALL TO ambatu_dev_video_writer USING (true) WITH CHECK (true);
COMMIT;
