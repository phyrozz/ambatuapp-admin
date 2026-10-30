-- DEV ONLY. The server checks player and Studio authorization before assuming this role.
BEGIN;
CREATE ROLE ambatu_dev_video_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT ambatu_dev_video_writer TO ambatu_dev_content_reader;
GRANT USAGE ON SCHEMA app TO ambatu_dev_video_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.content, app.videos, app.comments, app.content_votes, app.comment_votes TO ambatu_dev_video_writer;
GRANT SELECT (id, username, avatar_key) ON app.player_profiles TO ambatu_dev_video_writer;
CREATE POLICY dev_video_content ON app.content FOR ALL TO ambatu_dev_video_writer USING (kind = 'video') WITH CHECK (kind = 'video');
CREATE POLICY dev_video_details ON app.videos FOR ALL TO ambatu_dev_video_writer USING (true) WITH CHECK (kind = 'video');
CREATE POLICY dev_video_comments ON app.comments FOR ALL TO ambatu_dev_video_writer USING (content_kind = 'video') WITH CHECK (content_kind = 'video');
CREATE POLICY dev_video_votes ON app.content_votes FOR ALL TO ambatu_dev_video_writer USING (content_kind = 'video') WITH CHECK (content_kind = 'video');
CREATE POLICY dev_video_comment_votes ON app.comment_votes FOR ALL TO ambatu_dev_video_writer USING (content_kind = 'video') WITH CHECK (content_kind = 'video');
CREATE POLICY dev_video_profiles ON app.player_profiles FOR SELECT TO ambatu_dev_video_writer USING (true);
CREATE INDEX dev_studio_video_list ON app.content (kind, id COLLATE "C");
COMMIT;
