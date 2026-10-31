-- Read-only checks after 001 and 002. Raises an error for broken coverage or access.
DO $verify$
DECLARE item record; matches bigint; role_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.migration_runs WHERE id = 'firestore-prod-v1' AND source_project = 'ambatuapp-bcebb'
      AND source_count = (SELECT count(*) FROM migration_staging.firestore_documents)
      AND source_fingerprint = (SELECT md5(coalesce(string_agg(md5(path || document::text), '' ORDER BY path), ''))
        FROM migration_staging.firestore_documents)) THEN
    RAISE EXCEPTION 'Staging no longer matches the imported dataset fingerprint';
  END IF;
  IF (SELECT count(*) FROM migration_staging.firestore_documents)
      <> (SELECT count(*) FROM app.migration_documents) THEN
    RAISE EXCEPTION 'Source and migration ledger counts disagree';
  END IF;
  IF EXISTS (SELECT path FROM migration_staging.firestore_documents EXCEPT SELECT source_path FROM app.migration_documents)
      OR EXISTS (SELECT source_path FROM app.migration_documents EXCEPT SELECT path FROM migration_staging.firestore_documents) THEN
    RAISE EXCEPTION 'Source path coverage mismatch';
  END IF;
  FOR item IN SELECT * FROM app.migration_documents LOOP
    EXECUTE format('SELECT count(*) FROM app.%I t WHERE to_jsonb(t) @> $1', item.destination)
      INTO matches USING item.destination_key;
    IF matches <> 1 THEN RAISE EXCEPTION 'A source document has no unique destination row'; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM app.content c
    LEFT JOIN app.characters a ON c.kind = 'character' AND a.id = c.id
    LEFT JOIN app.lores l ON c.kind = 'lore' AND l.id = c.id
    LEFT JOIN app.videos v ON c.kind = 'video' AND v.id = c.id
    LEFT JOIN app.sounds s ON c.kind = 'sound' AND s.id = c.id
    WHERE coalesce(a.id, l.id, v.id, s.id) IS NULL) THEN
    RAISE EXCEPTION 'Content detail row missing';
  END IF;
  IF EXISTS (SELECT 1 FROM app.firestore_orphan_documents o JOIN migration_staging.firestore_documents s ON s.path=o.source_path
      WHERE o.document IS DISTINCT FROM s.document OR o.reason <> 'missing_content_parent') THEN
    RAISE EXCEPTION 'Archived source document mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM app.content c JOIN app.migration_documents m
      ON m.destination='content' AND m.destination_key->>'kind'=c.kind AND m.destination_key->>'id'=c.id
      JOIN migration_staging.firestore_documents s ON s.path=m.source_path
      WHERE c.created_at IS DISTINCT FROM migration_staging.firestore_timestamp(migration_staging.firestore_value(s.document->'fields'->'createdAt'))) THEN
    RAISE EXCEPTION 'Content creation timestamp mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class t JOIN pg_namespace n ON t.relnamespace = n.oid
      WHERE n.nspname = 'app' AND t.relkind = 'r' AND NOT t.relrowsecurity) THEN
    RAISE EXCEPTION 'An app table does not have RLS enabled';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      IF has_schema_privilege(role_name, 'app', 'USAGE') THEN
        RAISE EXCEPTION 'App schema is accessible to %', role_name;
      END IF;
      IF has_schema_privilege(role_name, 'migration_staging', 'USAGE')
          OR has_table_privilege(role_name, 'migration_staging.firestore_documents', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
        RAISE EXCEPTION 'Unexpected staging access for %', role_name;
      END IF;
      FOR item IN SELECT tablename FROM pg_tables WHERE schemaname = 'app' LOOP
        IF has_table_privilege(role_name, format('app.%I', item.tablename), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
          RAISE EXCEPTION 'Unexpected table privileges for %', role_name;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END
$verify$;

SELECT source_project, source_count, completed_at FROM app.migration_runs;
SELECT destination, count(*) AS source_documents FROM app.migration_documents GROUP BY destination ORDER BY destination;
SELECT kind, count(*) AS content_rows FROM app.content GROUP BY kind ORDER BY kind;

-- Review these diagnostics before changing APIs; historical counters are preserved.
SELECT 'duplicate_profile_usernames' AS diagnostic, count(*) AS issues FROM (
  SELECT username_lower FROM app.player_profiles WHERE username_lower IS NOT NULL
    GROUP BY username_lower HAVING count(*) > 1
) duplicates
UNION ALL
SELECT 'username_claim_profile_mismatches', count(*) FROM app.username_claims c
  JOIN app.player_profiles p ON p.id = c.player_id WHERE p.username_lower IS DISTINCT FROM c.username_lower
UNION ALL
SELECT 'studio_role_counter_mismatches', count(*) FROM app.studio_roles r
  WHERE r.imported_user_count IS DISTINCT FROM (SELECT count(*) FROM app.studio_users u WHERE u.role_id = r.id AND u.enabled)
UNION ALL
SELECT 'content_comment_counter_mismatches', count(*) FROM app.content c
  WHERE c.comment_count <> (SELECT count(*) FROM app.comments m WHERE m.content_kind = c.kind AND m.content_id = c.id);
