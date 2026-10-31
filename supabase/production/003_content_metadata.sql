-- Preserve Firestore's missing-vs-null status distinction for legacy sounds.
BEGIN;
ALTER TABLE app.content ADD COLUMN status_missing boolean NOT NULL DEFAULT false;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.migration_runs WHERE id='firestore-prod-v1' AND source_project='ambatuapp-bcebb') THEN
    RAISE EXCEPTION 'Expected completed production import';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.migration_runs WHERE id='firestore-prod-v1'
    AND source_count=(SELECT count(*) FROM migration_staging.firestore_documents)
    AND source_fingerprint=(SELECT md5(coalesce(string_agg(md5(path || document::text), '' ORDER BY path), '')) FROM migration_staging.firestore_documents)) THEN
    RAISE EXCEPTION 'Staging no longer matches the imported dataset';
  END IF;
  IF EXISTS (SELECT 1 FROM app.content c WHERE NOT EXISTS (
    SELECT 1 FROM app.migration_documents m WHERE m.destination='content'
      AND m.destination_key->>'kind'=c.kind AND m.destination_key->>'id'=c.id
  )) THEN RAISE EXCEPTION 'App contains content not covered by the production import'; END IF;
  UPDATE app.content c SET status_missing = NOT (coalesce(s.document->'fields', '{}'::jsonb) ? 'status')
    FROM app.migration_documents m JOIN migration_staging.firestore_documents s ON s.path=m.source_path
    WHERE m.destination='content' AND m.destination_key->>'kind'=c.kind AND m.destination_key->>'id'=c.id;
END
$migration$;
ALTER TABLE app.content ADD CONSTRAINT content_missing_status CHECK (NOT status_missing OR status IS NULL);
CREATE INDEX production_character_name_page ON app.characters (name COLLATE "C", id COLLATE "C") WHERE name IS NOT NULL;
CREATE INDEX production_sound_name_page ON app.sounds (name COLLATE "C", id COLLATE "C") WHERE name IS NOT NULL;
CREATE INDEX production_content_time_page ON app.content (kind, status, (coalesce(created_at, '1970-01-01T00:00:00Z'::timestamptz)) DESC, id COLLATE "C");
CREATE INDEX production_content_votes_page ON app.content (kind, status, upvotes DESC, (coalesce(created_at, '1970-01-01T00:00:00Z'::timestamptz)) DESC, id COLLATE "C");
COMMIT;
