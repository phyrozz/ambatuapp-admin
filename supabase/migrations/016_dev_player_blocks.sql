-- Apply before deploying the block-aware API. No browser role may read blocks.
BEGIN;
CREATE TABLE app.player_blocks (
  blocker_id text NOT NULL,
  blocked_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX player_blocks_incoming ON app.player_blocks (blocked_id, blocker_id);
ALTER TABLE app.player_blocks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.player_blocks FROM PUBLIC;
DO $security$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON app.player_blocks FROM %I', role_name);
    END IF;
  END LOOP;
END
$security$;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.player_blocks TO ambatu_dev_social_writer;
CREATE POLICY dev_social_blocks ON app.player_blocks FOR ALL TO ambatu_dev_social_writer USING (true) WITH CHECK (true);
-- Set this LOGIN role's password separately in the stage secret store.
CREATE ROLE ambatu_dev_chat_relationship_reader LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA app TO ambatu_dev_chat_relationship_reader;
GRANT SELECT ON app.player_blocks TO ambatu_dev_chat_relationship_reader;
CREATE POLICY dev_chat_blocks ON app.player_blocks FOR SELECT TO ambatu_dev_chat_relationship_reader USING (true);
COMMIT;
