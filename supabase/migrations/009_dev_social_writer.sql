-- DEV ONLY. Player authorization is checked by the API before assuming this role.
BEGIN;
CREATE ROLE ambatu_dev_social_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT ambatu_dev_social_writer TO ambatu_dev_content_reader;
GRANT USAGE ON SCHEMA app TO ambatu_dev_social_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.follows, app.friendships TO ambatu_dev_social_writer;
CREATE POLICY dev_social_follows ON app.follows FOR ALL TO ambatu_dev_social_writer USING (true) WITH CHECK (true);
CREATE POLICY dev_social_friendships ON app.friendships FOR ALL TO ambatu_dev_social_writer USING (true) WITH CHECK (true);
COMMIT;
