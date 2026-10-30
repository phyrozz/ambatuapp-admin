-- DEV ONLY. This role is assumed in transactions after server-side Cognito checks.
BEGIN;
CREATE ROLE ambatu_dev_lore_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT ambatu_dev_lore_writer TO ambatu_dev_content_reader;
GRANT USAGE ON SCHEMA app TO ambatu_dev_lore_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.content, app.lores, app.comments, app.content_votes, app.comment_votes TO ambatu_dev_lore_writer;
GRANT SELECT, INSERT ON app.content_visitors TO ambatu_dev_lore_writer;
GRANT SELECT (id, username, avatar_key) ON app.player_profiles TO ambatu_dev_lore_writer;
CREATE POLICY dev_lore_content ON app.content FOR ALL TO ambatu_dev_lore_writer
  USING (kind = 'lore') WITH CHECK (kind = 'lore');
CREATE POLICY dev_lore_details ON app.lores FOR ALL TO ambatu_dev_lore_writer
  USING (true) WITH CHECK (kind = 'lore');
CREATE POLICY dev_lore_comments ON app.comments FOR ALL TO ambatu_dev_lore_writer
  USING (content_kind = 'lore') WITH CHECK (content_kind = 'lore');
CREATE POLICY dev_lore_content_votes ON app.content_votes FOR ALL TO ambatu_dev_lore_writer
  USING (content_kind = 'lore') WITH CHECK (content_kind = 'lore');
CREATE POLICY dev_lore_comment_votes ON app.comment_votes FOR ALL TO ambatu_dev_lore_writer
  USING (content_kind = 'lore') WITH CHECK (content_kind = 'lore');
CREATE POLICY dev_lore_views ON app.content_visitors FOR SELECT TO ambatu_dev_lore_writer
  USING (content_kind = 'lore' AND event = 'view');
CREATE POLICY dev_lore_new_views ON app.content_visitors FOR INSERT TO ambatu_dev_lore_writer
  WITH CHECK (content_kind = 'lore' AND event = 'view');
CREATE POLICY dev_lore_profiles ON app.player_profiles FOR SELECT TO ambatu_dev_lore_writer USING (true);
CREATE INDEX dev_studio_lore_list ON app.content (kind, id COLLATE "C");
COMMIT;
