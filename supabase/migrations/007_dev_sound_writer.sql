-- DEV ONLY. Application authorization happens before this role is assumed.
BEGIN;
CREATE ROLE ambatu_dev_sound_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT ambatu_dev_sound_writer TO ambatu_dev_content_reader;
GRANT USAGE ON SCHEMA app TO ambatu_dev_sound_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.content, app.sounds TO ambatu_dev_sound_writer;
GRANT SELECT, INSERT ON app.content_visitors TO ambatu_dev_sound_writer;
CREATE POLICY dev_sound_content ON app.content FOR ALL TO ambatu_dev_sound_writer
  USING (kind = 'sound') WITH CHECK (kind = 'sound');
CREATE POLICY dev_sound_details ON app.sounds FOR ALL TO ambatu_dev_sound_writer
  USING (true) WITH CHECK (kind = 'sound');
CREATE POLICY dev_sound_listeners ON app.content_visitors FOR SELECT TO ambatu_dev_sound_writer
  USING (content_kind = 'sound' AND event = 'listen');
CREATE POLICY dev_sound_new_listeners ON app.content_visitors FOR INSERT TO ambatu_dev_sound_writer
  WITH CHECK (content_kind = 'sound' AND event = 'listen');
CREATE INDEX dev_studio_sound_list ON app.content (kind, id COLLATE "C");
COMMIT;
