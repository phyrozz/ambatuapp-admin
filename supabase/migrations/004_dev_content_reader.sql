-- Apply only to the isolated dev Supabase project. Set the role password with psql \password.
BEGIN;
CREATE ROLE ambatu_dev_content_reader LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA app TO ambatu_dev_content_reader;
GRANT SELECT ON app.migration_runs, app.content, app.characters, app.lores, app.videos, app.sounds, app.content_votes TO ambatu_dev_content_reader;
GRANT SELECT (id, username, avatar_key) ON app.player_profiles TO ambatu_dev_content_reader;

CREATE POLICY dev_content_marker ON app.migration_runs FOR SELECT TO ambatu_dev_content_reader
  USING (id = 'firestore-dev-v1' AND source_project = 'ambatuapp-dev');
CREATE POLICY dev_content_public ON app.content FOR SELECT TO ambatu_dev_content_reader
  USING (status = 'Published' OR (kind = 'sound' AND status_missing));
CREATE POLICY dev_characters_public ON app.characters FOR SELECT TO ambatu_dev_content_reader
  USING (EXISTS (SELECT 1 FROM app.content c WHERE c.kind = characters.kind AND c.id = characters.id));
CREATE POLICY dev_lores_public ON app.lores FOR SELECT TO ambatu_dev_content_reader
  USING (EXISTS (SELECT 1 FROM app.content c WHERE c.kind = lores.kind AND c.id = lores.id));
CREATE POLICY dev_videos_public ON app.videos FOR SELECT TO ambatu_dev_content_reader
  USING (EXISTS (SELECT 1 FROM app.content c WHERE c.kind = videos.kind AND c.id = videos.id));
CREATE POLICY dev_sounds_public ON app.sounds FOR SELECT TO ambatu_dev_content_reader
  USING (EXISTS (SELECT 1 FROM app.content c WHERE c.kind = sounds.kind AND c.id = sounds.id));
CREATE POLICY dev_public_profiles ON app.player_profiles FOR SELECT TO ambatu_dev_content_reader USING (true);
CREATE POLICY dev_public_content_votes ON app.content_votes FOR SELECT TO ambatu_dev_content_reader
  USING (EXISTS (SELECT 1 FROM app.content c WHERE c.kind = content_votes.content_kind AND c.id = content_votes.content_id));
COMMIT;
