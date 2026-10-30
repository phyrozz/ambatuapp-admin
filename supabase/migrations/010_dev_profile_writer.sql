-- DEV ONLY. Cognito and Studio permissions are checked by the server before this role is assumed.
BEGIN;
CREATE ROLE ambatu_dev_profile_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT ambatu_dev_profile_writer TO ambatu_dev_content_reader;
GRANT USAGE ON SCHEMA app TO ambatu_dev_profile_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.player_profiles, app.username_claims, app.profile_avatars, app.avatar_moderation TO ambatu_dev_profile_writer;
CREATE POLICY dev_profiles ON app.player_profiles FOR ALL TO ambatu_dev_profile_writer USING (true) WITH CHECK (true);
CREATE POLICY dev_username_claims ON app.username_claims FOR ALL TO ambatu_dev_profile_writer USING (true) WITH CHECK (true);
CREATE POLICY dev_profile_avatars ON app.profile_avatars FOR ALL TO ambatu_dev_profile_writer USING (true) WITH CHECK (true);
CREATE POLICY dev_avatar_moderation ON app.avatar_moderation FOR ALL TO ambatu_dev_profile_writer USING (true) WITH CHECK (true);
COMMIT;
