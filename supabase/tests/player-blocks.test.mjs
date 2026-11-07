// Disposable local PostgreSQL only. Never point this at Supabase or live data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';

const require = createRequire(import.meta.url);
const port = process.env.PGTEST_PORT;
const root = fileURLToPath(new URL('../../src/', import.meta.url));
function loader(mocks) {
  const cache = new Map();
  function load(filename) {
    const file = path.resolve(root, filename);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const dep = specifier => {
      for (const [suffix, value] of Object.entries(mocks)) if (specifier.endsWith(suffix)) return value;
      return specifier.startsWith('.') ? load(`${path.resolve(path.dirname(file), specifier)}.ts`) : require(specifier);
    };
    vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { Request, Response, URL, Buffer, console, Date, Map, Set, Error })(dep, module, module.exports);
    return module.exports;
  }
  return load;
}

test('blocks serialize with friends/follows, hide identities, paginate and enforce database roles', { skip: !port }, async () => {
  const admin = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', database: 'postgres' });
  const database = `blocks_test_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const db = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', database });
  let reader;
  try {
    await db.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ambatu_dev_content_reader') THEN CREATE ROLE ambatu_dev_content_reader LOGIN NOINHERIT; END IF;
      END $$`);
    await db.query(readFileSync(new URL('../migrations/001_app_schema.sql', import.meta.url), 'utf8'));
    // The local cluster is disposable; roles may already exist after another fixture.
    if (!(await db.query("SELECT 1 FROM pg_roles WHERE rolname='ambatu_dev_social_writer'")).rowCount) {
      await db.query(readFileSync(new URL('../migrations/009_dev_social_writer.sql', import.meta.url), 'utf8'));
    } else {
      await db.query('GRANT USAGE ON SCHEMA app TO ambatu_dev_social_writer; GRANT ALL ON app.friendships,app.follows TO ambatu_dev_social_writer');
      await db.query('CREATE POLICY fixture_friendships ON app.friendships FOR ALL TO ambatu_dev_social_writer USING (true); CREATE POLICY fixture_follows ON app.follows FOR ALL TO ambatu_dev_social_writer USING (true)');
    }
    // Remove only the empty fixture role from previous runs, never a deployed role.
    if ((await db.query("SELECT 1 FROM pg_roles WHERE rolname='ambatu_dev_chat_relationship_reader'")).rowCount) await db.query('DROP ROLE ambatu_dev_chat_relationship_reader');
    await db.query(readFileSync(new URL('../migrations/016_dev_player_blocks.sql', import.meta.url), 'utf8'));
    reader = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'ambatu_dev_content_reader', database, max: 8 });
    const withDb = async callback => {
      const client = await reader.connect();
      try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE ambatu_dev_social_writer'); const result = await callback(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    };
    const load = loader({ '/dev-content-db': { withDevSocialDb: withDb, isDevSocialWriter: () => true } });
    const blocks = load('lib/player-blocks.ts'), social = load('lib/dev-social.ts');
    await social.changeFriend('alice', 'bob', 'request');
    await social.changeFriend('bob', 'alice', 'accept');
    await social.changeFollow('alice', 'bob', 'follow');
    await blocks.changePlayerBlock('alice', 'bob', true);
    assert.equal((await db.query('SELECT 1 FROM app.friendships')).rowCount, 0);
    assert.equal((await db.query('SELECT 1 FROM app.follows')).rowCount, 0);
    assert((await blocks.hiddenPlayerIds('alice', ['bob'])).has('bob'));
    assert((await blocks.hiddenPlayerIds('bob', ['alice'])).has('alice'));
    assert.equal((await blocks.hiddenPlayerIds(null, ['alice'])).size, 0);
    await assert.rejects(social.changeFriend('bob', 'alice', 'request'), /PLAYER_NOT_FOUND/);
    await assert.rejects(social.changeFollow('alice', 'bob', 'follow'), /PLAYER_NOT_FOUND/);
    assert.equal((await blocks.dreamRelationship('bob', 'alice')).blocked, true);
    await blocks.changePlayerBlock('alice', 'bob', false);
    assert.equal((await db.query('SELECT 1 FROM app.friendships')).rowCount, 0, 'Unblocking cannot recreate friendship');
    for (let i = 0; i < 12; i++) {
      await blocks.changePlayerBlock('alice', 'bob', false);
      await Promise.allSettled([social.changeFriend('bob', 'alice', 'request'), blocks.changePlayerBlock('alice', 'bob', true)]);
      assert.equal((await db.query('SELECT 1 FROM app.friendships')).rowCount, 0, 'A concurrent request cannot survive a block');
    }
    await blocks.changePlayerBlock('alice', 'bob', false);
    await social.changeFriend('alice', 'bob', 'request');
    assert.equal((await blocks.dreamRelationship('alice', 'bob')).acceptedByViewer, false);
    await social.changeFriend('bob', 'alice', 'accept');
    assert.equal((await blocks.dreamRelationship('alice', 'bob')).acceptedByAuthor, true);
    await Promise.all(Array.from({ length: 25 }, (_, i) => blocks.changePlayerBlock('alice', `user-${String(i).padStart(2,'0')}`, true)));
    const first = await blocks.listPlayerBlocks('alice', null), second = await blocks.listPlayerBlocks('alice', first.nextCursor);
    assert.equal(first.items.length, 20); assert.equal(second.items.length, 5); assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 25);
    await assert.rejects(reader.query('SELECT * FROM app.player_blocks'), /permission denied/);
    const chat = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'ambatu_dev_chat_relationship_reader', database });
    try {
      assert.equal((await chat.query('SELECT count(*) FROM app.player_blocks')).rows[0].count, '25');
      await assert.rejects(chat.query('DELETE FROM app.player_blocks'), /permission denied/);
      await assert.rejects(chat.query('SELECT * FROM app.player_profiles'), /permission denied/);
    } finally { await chat.end(); }
    const grants = await db.query("SELECT has_table_privilege('anon','app.player_blocks','SELECT') AS anon, has_table_privilege('authenticated','app.player_blocks','SELECT') AS authenticated");
    assert.deepEqual(grants.rows[0], { anon: false, authenticated: false });
  } finally {
    await reader?.end(); await db.end();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); await admin.end();
  }
});

test('production block migration grants read-only chat access and isolates API roles', { skip: !port }, async () => {
  const admin = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', database: 'postgres' });
  const database = `blocks_prod_test_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const db = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', database });
  try {
    await db.query('CREATE SCHEMA app');
    await db.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ambatu_prod_social_writer') THEN CREATE ROLE ambatu_prod_social_writer NOLOGIN; END IF; END $$`);
    if ((await db.query("SELECT 1 FROM pg_roles WHERE rolname='ambatu_prod_chat_relationship_reader'")).rowCount) await db.query('DROP ROLE ambatu_prod_chat_relationship_reader');
    await db.query(readFileSync(new URL('../production/008_player_blocks.sql', import.meta.url), 'utf8'));
    await db.query("INSERT INTO app.player_blocks VALUES ('alice','bob',now())");
    const result = await db.query(`SELECT has_table_privilege('ambatu_prod_chat_relationship_reader','app.player_blocks','SELECT') AS read,
      has_table_privilege('ambatu_prod_chat_relationship_reader','app.player_blocks','INSERT') AS write,
      has_table_privilege('anon','app.player_blocks','SELECT') AS anonymous`);
    assert.deepEqual(result.rows[0], { read: true, write: false, anonymous: false });
    await assert.rejects(db.query("INSERT INTO app.player_blocks VALUES ('alice','alice',now())"), /check constraint/);
  } finally {
    await db.end(); await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); await admin.end();
  }
});
