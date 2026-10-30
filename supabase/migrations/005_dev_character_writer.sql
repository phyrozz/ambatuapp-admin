-- DEV ONLY: extend the local snapshot reader with an explicit, assumable
-- character writer role. The ordinary connection remains read-only.
BEGIN;
CREATE ROLE ambatu_dev_character_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT ambatu_dev_character_writer TO ambatu_dev_content_reader;
GRANT USAGE ON SCHEMA app TO ambatu_dev_character_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.content, app.characters TO ambatu_dev_character_writer;
GRANT SELECT, INSERT ON app.content_visitors TO ambatu_dev_character_writer;
CREATE POLICY dev_character_writer_content ON app.content FOR ALL TO ambatu_dev_character_writer
  USING (kind = 'character') WITH CHECK (kind = 'character');
CREATE POLICY dev_character_writer_details ON app.characters FOR ALL TO ambatu_dev_character_writer
  USING (true) WITH CHECK (kind = 'character');
CREATE POLICY dev_character_writer_views ON app.content_visitors FOR SELECT TO ambatu_dev_character_writer
  USING (content_kind = 'character' AND event = 'view');
CREATE POLICY dev_character_writer_new_views ON app.content_visitors FOR INSERT TO ambatu_dev_character_writer
  WITH CHECK (content_kind = 'character' AND event = 'view');
CREATE INDEX dev_studio_character_list ON app.content (kind, id COLLATE "C");
COMMIT;
