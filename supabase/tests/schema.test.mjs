// Integration tests require a disposable, LOCAL PostgreSQL server, not Supabase.
// Example: $env:PGTEST_PORT='55439'; node --test supabase/tests/schema.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const port = process.env.PGTEST_PORT;
const database = `ambatu_schema_test_${Date.now()}`;
const args = ['-X', '-h', '127.0.0.1', '-p', port ?? '0', '-U', 'postgres', '-w', '-v', 'ON_ERROR_STOP=1'];
const file = name => fileURLToPath(new URL(`../${name}`, import.meta.url));
const psql = (db, more) => execFileSync('psql', [...args, '-d', db, ...more], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

test('schema/import preserves types and relationships, rejects unsafe reimports and sources', { skip: !port }, () => {
  psql('postgres', ['-c', `CREATE DATABASE ${database}`]);
  try {
    psql(database, ['-c', `
      CREATE SCHEMA migration_staging;
      CREATE TABLE migration_staging.firestore_documents (path text PRIMARY KEY, document jsonb NOT NULL);
      INSERT INTO migration_staging.firestore_documents
      SELECT path, jsonb_build_object('name','projects/ambatuapp-dev/databases/(default)/documents/' || path,
        'createTime','2026-01-01T00:00:00Z','fields',fields)
      FROM (VALUES
        ('characters/same', '{"name":{"stringValue":"Character"},"tags":{"arrayValue":{"values":[{"stringValue":"a"},{"stringValue":"b"}]}},"legacyCount":{"integerValue":"9223372036854775807"},"createdAt":{"nullValue":null}}'::jsonb),
        ('lores/same', '{"text":{"stringValue":"Lore"},"translations":{"arrayValue":{"values":[{"mapValue":{"fields":{"locale":{"stringValue":"id"},"text":{"stringValue":"Text"}}}}]}}}'::jsonb),
        ('lores/same/comments/reply', '{"text":{"stringValue":"Reply"},"parentId":{"stringValue":"first"}}'::jsonb),
        ('lores/same/comments/first', '{"text":{"stringValue":"First"}}'::jsonb),
        ('lores/same/comments/reply/votes/user:a', '{"value":{"integerValue":"-1"}}'::jsonb),
        ('soundboardSounds/sound', '{"name":{"stringValue":"Sound"},"category":{"stringValue":"Other"}}'::jsonb),
        ('soundboardSounds/sound/creatorListeners/hash', '{"listenedAt":{"timestampValue":"2026-01-01T00:00:00Z"}}'::jsonb),
        ('profileAvatars/avatar', '{"imageKey":{"stringValue":"avatars/test.png"}}'::jsonb),
        ('leaderboards/game/entries/a', '{"score":{"integerValue":"42"}}'::jsonb)
      ) AS fixture(path,fields);`]);
    psql(database, ['-f', file('migrations/001_app_schema.sql'), '-f', file('migrations/002_import_firestore_dev.sql'), '-f', file('verify_firestore_dev.sql')]);
    assert.equal(psql(database, ['-Atc', 'SELECT count(*) FROM app.content']).trim(), '3');
    assert.equal(psql(database, ['-Atc', "SELECT extra->>'legacyCount' FROM app.content WHERE kind='character'"]).trim(), '9223372036854775807');
    assert.equal(psql(database, ['-Atc', "SELECT tags->>1 FROM app.characters"]).trim(), 'b');
    assert.equal(psql(database, ['-Atc', "SELECT translations->0->>'locale' FROM app.lores"]).trim(), 'id');
    assert.equal(psql(database, ['-Atc', 'SELECT created_at IS NULL FROM app.content WHERE kind=\'character\'']).trim(), 't');
    assert.equal(psql(database, ['-Atc', 'SELECT status IS NULL FROM app.content WHERE kind=\'sound\'']).trim(), 't');
    psql(database, ['-c', "UPDATE app.characters SET name='Edited after import'"]);
    psql(database, ['-f', file('migrations/002_import_firestore_dev.sql')]);
    assert.equal(psql(database, ['-Atc', 'SELECT name FROM app.characters']).trim(), 'Edited after import');
    psql(database, ['-c', "UPDATE migration_staging.firestore_documents SET document=jsonb_set(document,'{fields,new}', '{\"stringValue\":\"changed\"}') WHERE path='characters/same'"]);
    const rerun = spawnSync('psql', [...args, '-d', database, '-f', file('migrations/002_import_firestore_dev.sql')], { encoding: 'utf8' });
    assert.notEqual(rerun.status, 0);
    assert.match(rerun.stderr, /different dataset/);
    psql(database, ['-c', "UPDATE migration_staging.firestore_documents SET document=jsonb_set(document,'{name}',to_jsonb(replace(document->>'name','ambatuapp-dev','production'))) WHERE path='characters/same'"]);
    const wrongProject = spawnSync('psql', [...args, '-d', database, '-f', file('migrations/002_import_firestore_dev.sql')], { encoding: 'utf8' });
    assert.notEqual(wrongProject.status, 0);
    assert.match(wrongProject.stderr, /not an ambatuapp-dev/);
    // Test atomic failure after inserts: clear only this disposable test schema.
    psql(database, ['-c', 'DROP SCHEMA app CASCADE', '-f', file('migrations/001_app_schema.sql'), '-c', `
      DELETE FROM migration_staging.firestore_documents;
      INSERT INTO migration_staging.firestore_documents VALUES ('videos/missing/votes/user:a',
        '{"name":"projects/ambatuapp-dev/databases/(default)/documents/videos/missing/votes/user:a","createTime":"2026-01-01T00:00:00Z","fields":{"value":{"integerValue":"1"}}}');`]);
    const orphan = spawnSync('psql', [...args, '-d', database, '-f', file('migrations/002_import_firestore_dev.sql')], { encoding: 'utf8' });
    assert.notEqual(orphan.status, 0);
    assert.match(orphan.stderr, /foreign key constraint/);
    assert.equal(psql(database, ['-Atc', 'SELECT count(*) FROM app.migration_runs']).trim(), '0');
    assert.equal(psql(database, ['-Atc', 'SELECT count(*) FROM app.content_votes']).trim(), '0');
  } finally {
    psql('postgres', ['-c', `DROP DATABASE ${database} WITH (FORCE)`]);
  }
});
