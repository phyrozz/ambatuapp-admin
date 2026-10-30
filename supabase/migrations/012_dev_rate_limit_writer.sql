-- DEV ONLY. Only the trusted server assumes this role, after configuration checks.
BEGIN;
CREATE ROLE ambatu_dev_rate_limit_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT ambatu_dev_rate_limit_writer TO ambatu_dev_content_reader;
GRANT USAGE ON SCHEMA app TO ambatu_dev_rate_limit_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.public_api_rate_limits TO ambatu_dev_rate_limit_writer;
CREATE POLICY dev_rate_limits ON app.public_api_rate_limits FOR ALL TO ambatu_dev_rate_limit_writer USING (true) WITH CHECK (true);
COMMIT;
