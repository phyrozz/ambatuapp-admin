// Local rehearsal only. PGTEST_PORT must point to a disposable local cluster;
// the prod_role_rehearsal database must already have the production migrations.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const port = process.env.PGTEST_PORT;
test('production server login cannot directly read private data or staging', { skip: !port }, async () => {
  const db = new pg.Client({ host: '127.0.0.1', port: Number(port), user: 'ambatu_prod_content_reader', database: 'prod_role_rehearsal' });
  await db.connect();
  try {
    assert.equal((await db.query("SELECT count(*)::int AS n FROM app.migration_runs WHERE id='firestore-prod-v1' AND source_project='ambatuapp-bcebb'")).rows[0].n, 1);
    for (const sql of ['SELECT birth_date FROM app.player_profiles LIMIT 1', 'SELECT * FROM app.studio_users LIMIT 1',
      'SELECT * FROM app.firestore_orphan_documents LIMIT 1', 'SELECT * FROM migration_staging.firestore_documents LIMIT 1']) {
      await assert.rejects(db.query(sql), /permission denied/);
    }
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE ambatu_prod_video_writer');
      assert.equal((await db.query("SELECT count(*)::int AS n FROM app.content WHERE kind='lore'")).rows[0].n, 0);
      await assert.rejects(db.query("INSERT INTO app.content (kind,id) VALUES ('lore','denied')"), /row-level security/);
    } finally { await db.query('ROLLBACK'); }
  } finally { await db.end(); }
});
