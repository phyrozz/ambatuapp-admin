-- Production server roles; run only after a verified, final production import and metadata migration.
-- These roles are for a trusted server, not for the Supabase Data API or browser clients.
BEGIN;
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.migration_runs WHERE id='firestore-prod-v1' AND source_project='ambatuapp-bcebb') THEN
    RAISE EXCEPTION 'Expected verified production import';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.migration_runs WHERE id='firestore-prod-v1' AND source_project='ambatuapp-bcebb'
      AND source_count=(SELECT count(*) FROM migration_staging.firestore_documents)
      AND source_fingerprint=(SELECT md5(coalesce(string_agg(md5(path || document::text), '' ORDER BY path), '')) FROM migration_staging.firestore_documents)) THEN
    RAISE EXCEPTION 'Production staging no longer matches the imported snapshot';
  END IF;
  IF (SELECT count(*) FROM app.migration_documents) <> (SELECT source_count FROM app.migration_runs WHERE id='firestore-prod-v1') THEN
    RAISE EXCEPTION 'Production migration coverage is incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.studio_users WHERE role_id='root' AND enabled AND NOT registration_pending) THEN
    RAISE EXCEPTION 'No enabled registered Studio root';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='app' AND table_name='content' AND column_name='status_missing') THEN
    RAISE EXCEPTION 'Expected production content metadata';
  END IF;
END
$guard$;

-- Derived from 004_dev_content_reader.sql; restricted to the production server role.
CREATE ROLE ambatu_prod_content_reader LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA app TO ambatu_prod_content_reader;
GRANT SELECT ON app.migration_runs, app.content, app.characters, app.lores, app.videos, app.sounds, app.content_votes TO ambatu_prod_content_reader;
GRANT SELECT (id, username, avatar_key) ON app.player_profiles TO ambatu_prod_content_reader;

CREATE POLICY prod_content_marker ON app.migration_runs FOR SELECT TO ambatu_prod_content_reader
  USING (id = 'firestore-prod-v1' AND source_project = 'ambatuapp-bcebb');
CREATE POLICY prod_content_public ON app.content FOR SELECT TO ambatu_prod_content_reader
  USING (status = 'Published' OR (kind = 'sound' AND status_missing));
CREATE POLICY prod_characters_public ON app.characters FOR SELECT TO ambatu_prod_content_reader
  USING (EXISTS (SELECT 1 FROM app.content c WHERE c.kind = characters.kind AND c.id = characters.id));
CREATE POLICY prod_lores_public ON app.lores FOR SELECT TO ambatu_prod_content_reader
  USING (EXISTS (SELECT 1 FROM app.content c WHERE c.kind = lores.kind AND c.id = lores.id));
CREATE POLICY prod_videos_public ON app.videos FOR SELECT TO ambatu_prod_content_reader
  USING (EXISTS (SELECT 1 FROM app.content c WHERE c.kind = videos.kind AND c.id = videos.id));
CREATE POLICY prod_sounds_public ON app.sounds FOR SELECT TO ambatu_prod_content_reader
  USING (EXISTS (SELECT 1 FROM app.content c WHERE c.kind = sounds.kind AND c.id = sounds.id));
CREATE POLICY prod_public_profiles ON app.player_profiles FOR SELECT TO ambatu_prod_content_reader USING (true);
CREATE POLICY prod_public_content_votes ON app.content_votes FOR SELECT TO ambatu_prod_content_reader
  USING (EXISTS (SELECT 1 FROM app.content c WHERE c.kind = content_votes.content_kind AND c.id = content_votes.content_id));

-- Derived from 005_dev_character_writer.sql; restricted to the production server role.
CREATE ROLE ambatu_prod_character_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT ambatu_prod_character_writer TO ambatu_prod_content_reader;
GRANT USAGE ON SCHEMA app TO ambatu_prod_character_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.content, app.characters TO ambatu_prod_character_writer;
GRANT SELECT, INSERT ON app.content_visitors TO ambatu_prod_character_writer;
CREATE POLICY prod_character_writer_content ON app.content FOR ALL TO ambatu_prod_character_writer
  USING (kind = 'character') WITH CHECK (kind = 'character');
CREATE POLICY prod_character_writer_details ON app.characters FOR ALL TO ambatu_prod_character_writer
  USING (true) WITH CHECK (kind = 'character');
CREATE POLICY prod_character_writer_views ON app.content_visitors FOR SELECT TO ambatu_prod_character_writer
  USING (content_kind = 'character' AND event = 'view');
CREATE POLICY prod_character_writer_new_views ON app.content_visitors FOR INSERT TO ambatu_prod_character_writer
  WITH CHECK (content_kind = 'character' AND event = 'view');
CREATE INDEX prod_studio_character_list ON app.content (kind, id COLLATE "C");

-- Derived from 006_dev_lore_writer.sql; restricted to the production server role.
CREATE ROLE ambatu_prod_lore_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT ambatu_prod_lore_writer TO ambatu_prod_content_reader;
GRANT USAGE ON SCHEMA app TO ambatu_prod_lore_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.content, app.lores, app.comments, app.content_votes, app.comment_votes TO ambatu_prod_lore_writer;
GRANT SELECT, INSERT ON app.content_visitors TO ambatu_prod_lore_writer;
GRANT SELECT (id, username, avatar_key) ON app.player_profiles TO ambatu_prod_lore_writer;
CREATE POLICY prod_lore_content ON app.content FOR ALL TO ambatu_prod_lore_writer
  USING (kind = 'lore') WITH CHECK (kind = 'lore');
CREATE POLICY prod_lore_details ON app.lores FOR ALL TO ambatu_prod_lore_writer
  USING (true) WITH CHECK (kind = 'lore');
CREATE POLICY prod_lore_comments ON app.comments FOR ALL TO ambatu_prod_lore_writer
  USING (content_kind = 'lore') WITH CHECK (content_kind = 'lore');
CREATE POLICY prod_lore_content_votes ON app.content_votes FOR ALL TO ambatu_prod_lore_writer
  USING (content_kind = 'lore') WITH CHECK (content_kind = 'lore');
CREATE POLICY prod_lore_comment_votes ON app.comment_votes FOR ALL TO ambatu_prod_lore_writer
  USING (content_kind = 'lore') WITH CHECK (content_kind = 'lore');
CREATE POLICY prod_lore_views ON app.content_visitors FOR SELECT TO ambatu_prod_lore_writer
  USING (content_kind = 'lore' AND event = 'view');
CREATE POLICY prod_lore_new_views ON app.content_visitors FOR INSERT TO ambatu_prod_lore_writer
  WITH CHECK (content_kind = 'lore' AND event = 'view');
CREATE POLICY prod_lore_profiles ON app.player_profiles FOR SELECT TO ambatu_prod_lore_writer USING (true);
CREATE INDEX prod_studio_lore_list ON app.content (kind, id COLLATE "C");

-- Derived from 007_dev_sound_writer.sql; restricted to the production server role.
CREATE ROLE ambatu_prod_sound_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT ambatu_prod_sound_writer TO ambatu_prod_content_reader;
GRANT USAGE ON SCHEMA app TO ambatu_prod_sound_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.content, app.sounds TO ambatu_prod_sound_writer;
GRANT SELECT, INSERT ON app.content_visitors TO ambatu_prod_sound_writer;
CREATE POLICY prod_sound_content ON app.content FOR ALL TO ambatu_prod_sound_writer
  USING (kind = 'sound') WITH CHECK (kind = 'sound');
CREATE POLICY prod_sound_details ON app.sounds FOR ALL TO ambatu_prod_sound_writer
  USING (true) WITH CHECK (kind = 'sound');
CREATE POLICY prod_sound_listeners ON app.content_visitors FOR SELECT TO ambatu_prod_sound_writer
  USING (content_kind = 'sound' AND event = 'listen');
CREATE POLICY prod_sound_new_listeners ON app.content_visitors FOR INSERT TO ambatu_prod_sound_writer
  WITH CHECK (content_kind = 'sound' AND event = 'listen');
CREATE INDEX prod_studio_sound_list ON app.content (kind, id COLLATE "C");

-- Derived from 008_dev_video_writer.sql; restricted to the production server role.
CREATE ROLE ambatu_prod_video_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT ambatu_prod_video_writer TO ambatu_prod_content_reader;
GRANT USAGE ON SCHEMA app TO ambatu_prod_video_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.content, app.videos, app.comments, app.content_votes, app.comment_votes TO ambatu_prod_video_writer;
GRANT SELECT (id, username, avatar_key) ON app.player_profiles TO ambatu_prod_video_writer;
CREATE POLICY prod_video_content ON app.content FOR ALL TO ambatu_prod_video_writer USING (kind = 'video') WITH CHECK (kind = 'video');
CREATE POLICY prod_video_details ON app.videos FOR ALL TO ambatu_prod_video_writer USING (true) WITH CHECK (kind = 'video');
CREATE POLICY prod_video_comments ON app.comments FOR ALL TO ambatu_prod_video_writer USING (content_kind = 'video') WITH CHECK (content_kind = 'video');
CREATE POLICY prod_video_votes ON app.content_votes FOR ALL TO ambatu_prod_video_writer USING (content_kind = 'video') WITH CHECK (content_kind = 'video');
CREATE POLICY prod_video_comment_votes ON app.comment_votes FOR ALL TO ambatu_prod_video_writer USING (content_kind = 'video') WITH CHECK (content_kind = 'video');
CREATE POLICY prod_video_profiles ON app.player_profiles FOR SELECT TO ambatu_prod_video_writer USING (true);
CREATE INDEX prod_studio_video_list ON app.content (kind, id COLLATE "C");

-- Derived from 009_dev_social_writer.sql; restricted to the production server role.
CREATE ROLE ambatu_prod_social_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT ambatu_prod_social_writer TO ambatu_prod_content_reader;
GRANT USAGE ON SCHEMA app TO ambatu_prod_social_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.follows, app.friendships TO ambatu_prod_social_writer;
CREATE POLICY prod_social_follows ON app.follows FOR ALL TO ambatu_prod_social_writer USING (true) WITH CHECK (true);
CREATE POLICY prod_social_friendships ON app.friendships FOR ALL TO ambatu_prod_social_writer USING (true) WITH CHECK (true);

-- Derived from 010_dev_profile_writer.sql; restricted to the production server role.
CREATE ROLE ambatu_prod_profile_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT ambatu_prod_profile_writer TO ambatu_prod_content_reader;
GRANT USAGE ON SCHEMA app TO ambatu_prod_profile_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.player_profiles, app.username_claims, app.profile_avatars, app.avatar_moderation TO ambatu_prod_profile_writer;
CREATE POLICY prod_profiles ON app.player_profiles FOR ALL TO ambatu_prod_profile_writer USING (true) WITH CHECK (true);
CREATE POLICY prod_username_claims ON app.username_claims FOR ALL TO ambatu_prod_profile_writer USING (true) WITH CHECK (true);
CREATE POLICY prod_profile_avatars ON app.profile_avatars FOR ALL TO ambatu_prod_profile_writer USING (true) WITH CHECK (true);
CREATE POLICY prod_avatar_moderation ON app.avatar_moderation FOR ALL TO ambatu_prod_profile_writer USING (true) WITH CHECK (true);

-- Derived from 011_dev_leaderboard_writer.sql; restricted to the production server role.
CREATE ROLE ambatu_prod_leaderboard_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT ambatu_prod_leaderboard_writer TO ambatu_prod_content_reader;
GRANT USAGE ON SCHEMA app TO ambatu_prod_leaderboard_writer;
GRANT SELECT, INSERT, UPDATE ON app.leaderboard_entries TO ambatu_prod_leaderboard_writer;
CREATE POLICY prod_leaderboard_entries ON app.leaderboard_entries FOR ALL TO ambatu_prod_leaderboard_writer USING (true) WITH CHECK (true);

-- Derived from 012_dev_rate_limit_writer.sql; restricted to the production server role.
CREATE ROLE ambatu_prod_rate_limit_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT ambatu_prod_rate_limit_writer TO ambatu_prod_content_reader;
GRANT USAGE ON SCHEMA app TO ambatu_prod_rate_limit_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.public_api_rate_limits TO ambatu_prod_rate_limit_writer;
CREATE POLICY prod_rate_limits ON app.public_api_rate_limits FOR ALL TO ambatu_prod_rate_limit_writer USING (true) WITH CHECK (true);

-- Derived from 013_dev_studio_writer.sql; restricted to the production server role.
INSERT INTO app.studio_modules (id,message_key,href) VALUES
 ('dashboard','studio.modules.dashboard','/dashboard'),('characters','studio.modules.characters','/'),
 ('lores','studio.modules.lores','/lores'),('videos','studio.modules.videos','/videos'),
 ('sounds','studio.modules.sounds','/sounds'),('profile-avatars','studio.modules.profileAvatars','/profile-avatars'),
 ('chat-reports','studio.modules.chatReports','/chat-reports'),('settings','studio.modules.settings','/settings'),
 ('users','studio.modules.users','/users'),('roles','studio.modules.roles','/roles') ON CONFLICT (id) DO NOTHING;
INSERT INTO app.studio_role_types (id,message_key) VALUES
 ('view','studio.actions.view'),('add','studio.actions.add'),('edit','studio.actions.edit'),
 ('delete','studio.actions.delete'),('upload','studio.actions.upload'),('download','studio.actions.download') ON CONFLICT (id) DO NOTHING;
CREATE ROLE ambatu_prod_studio_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT ambatu_prod_studio_writer TO ambatu_prod_content_reader;
GRANT USAGE ON SCHEMA app TO ambatu_prod_studio_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.studio_users, app.studio_roles, app.studio_role_permissions TO ambatu_prod_studio_writer;
GRANT SELECT ON app.studio_modules, app.studio_role_types TO ambatu_prod_studio_writer;
CREATE POLICY prod_studio_users ON app.studio_users FOR ALL TO ambatu_prod_studio_writer USING (true) WITH CHECK (true);
CREATE POLICY prod_studio_roles ON app.studio_roles FOR ALL TO ambatu_prod_studio_writer USING (true) WITH CHECK (true);
CREATE POLICY prod_studio_permissions ON app.studio_role_permissions FOR ALL TO ambatu_prod_studio_writer USING (true) WITH CHECK (true);
CREATE POLICY prod_studio_modules ON app.studio_modules FOR SELECT TO ambatu_prod_studio_writer USING (true);
CREATE POLICY prod_studio_role_types ON app.studio_role_types FOR SELECT TO ambatu_prod_studio_writer USING (true);

COMMIT;
