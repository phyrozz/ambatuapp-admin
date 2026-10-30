-- DEV ONLY. The API validates Cognito access tokens before invoking the writer.
BEGIN;
CREATE ROLE ambatu_dev_leaderboard_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT ambatu_dev_leaderboard_writer TO ambatu_dev_content_reader;
GRANT USAGE ON SCHEMA app TO ambatu_dev_leaderboard_writer;
GRANT SELECT, INSERT, UPDATE ON app.leaderboard_entries TO ambatu_dev_leaderboard_writer;
CREATE POLICY dev_leaderboard_entries ON app.leaderboard_entries FOR ALL TO ambatu_dev_leaderboard_writer USING (true) WITH CHECK (true);
COMMIT;
