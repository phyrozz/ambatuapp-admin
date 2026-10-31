-- Production staging contains full Firestore documents, including private data.
-- Run once only after independently verifying the destination project.
BEGIN;
CREATE SCHEMA migration_staging;
REVOKE ALL ON SCHEMA migration_staging FROM PUBLIC;
CREATE TABLE migration_staging.firestore_documents (
  path text PRIMARY KEY,
  document jsonb NOT NULL
);
ALTER TABLE migration_staging.firestore_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON migration_staging.firestore_documents FROM PUBLIC;
DO $security$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA migration_staging FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA migration_staging FROM %I', role_name);
    END IF;
  END LOOP;
END
$security$;
COMMIT;
