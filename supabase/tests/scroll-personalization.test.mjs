// Run only against a disposable local cluster with migrations 001, 008, 009 and 015.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';

const require = createRequire(import.meta.url), port = process.env.PGTEST_PORT;
function load(relative, mocks) {
  const file = new URL(relative, import.meta.url), mod = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: name => mocks[name] ?? require(name), Buffer, URL, process, console, Error, Date, Map, Set }, { filename: file.pathname });
  return mod.exports;
}

test('PostgreSQL personalization persists per account, handles concurrency and pages without repeats', { skip: !port }, async () => {
  const admin = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', database: 'postgres' });
  const reader = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'ambatu_dev_content_reader', database: 'postgres' });
  const transaction = role => async callback => {
    const client = await reader.connect();
    try { await client.query('BEGIN'); await client.query(`SET LOCAL ROLE ${role}`); const result = await callback(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  };
  const db = { withDevVideoDb: transaction('ambatu_dev_video_writer'), withDevSocialDb: transaction('ambatu_dev_social_writer') };
  const videos = load('../../src/lib/dev-videos.ts', { './dev-content-db': db, './admin-video': {}, './studio-content': {},
    './s3-videos': { signedVideoUrl: async key => `https://fixture.invalid/${key}` }, './character-list-pagination': {},
    './profile-avatars': { profileAvatarUrl: async () => null }, './player-profiles': { fallbackPlayerName: () => 'Player' } });
  const core = load('../../src/lib/scroll-ranking.ts', {});
  const service = load('../../src/lib/personalized-scroll.ts', { './dev-content-db': db, './dev-videos': videos, './scroll-ranking': core });
  const prefix = `scroll-test-${Date.now()}`, alice = `${prefix}-alice`, bob = `${prefix}-bob`;
  const ids = Array.from({ length: 53 }, (_, i) => `${prefix}-${String(i).padStart(2, '0')}`);
  try {
    for (const [index, id] of ids.entries()) {
      await admin.query("INSERT INTO app.content(kind,id,status,uploader_id,created_at) VALUES ('video',$1,$2,$3,now()-($4 * interval '1 microsecond'))", [id, index === 52 ? 'Draft' : 'Published', index % 2 ? bob : alice, index]);
      await admin.query('INSERT INTO app.videos(id,title,description,video_key) VALUES ($1,$2,$3,$4)', [id, index % 2 ? 'Cats' : 'Cars', '', `${id}.mp4`]);
    }
    await admin.query('INSERT INTO app.follows(follower_id,followed_id) VALUES ($1,$2)', [alice, bob]);
    const cold = await service.listPersonalizedScroll(alice, null);
    assert.equal(cold.videos.length, 8);
    assert.equal(cold.videos[0].uploaderId, bob);
    const refreshed = await service.listPersonalizedScroll(alice, null, { seed: 'refresh-test', exclude: cold.videos.map(item => item.id) });
    assert.equal(refreshed.videos.length, 8);
    assert(refreshed.videos.every(item => !cold.videos.some(prior => prior.id === item.id)));
    const resumed = await service.listPersonalizedScroll(alice, refreshed.nextCursor);
    assert(resumed.videos.every(item => !cold.videos.some(prior => prior.id === item.id) && !refreshed.videos.some(prior => prior.id === item.id)));
    assert.equal(await service.recordScrollWatch(alice, ids[52], { watchedMs: 1000, durationMs: 10000 }), false);
    assert.equal(await service.recordScrollWatch(alice, 'missing', { watchedMs: 1000, durationMs: 10000 }), false);
    await Promise.all(ids.slice(0, 12).map(id => service.recordScrollWatch(alice, id, { watchedMs: 9000, durationMs: 10000 })));
    await service.recordScrollWatch(alice, ids[0], { watchedMs: 500, durationMs: 10000 });
    let saved = (await admin.query('SELECT history FROM app.scroll_preferences WHERE player_id=$1', [alice])).rows[0].history;
    assert.equal(saved.length, 12);
    assert.equal(saved.find(item => item.id === ids[0]).watchedMs, 9000);
    assert.equal((await admin.query('SELECT * FROM app.scroll_preferences WHERE player_id=$1', [bob])).rowCount, 0);
    await admin.query("INSERT INTO app.content_votes(content_kind,content_id,voter_key,value,updated_at) VALUES ('video',$1,$2,1,now())", [ids[0], `user:${bob}`]);
    const bobSignals = await service.scrollSignals(bob, []);
    assert.equal(bobSignals.history.length, 1);
    assert.equal(bobSignals.votes.get(ids[0]), 1);
    assert.equal(bobSignals.history[0].creator, alice);
    await admin.query("UPDATE app.content_votes SET value=0 WHERE voter_key=$1", [`user:${bob}`]);
    assert.equal((await service.scrollSignals(bob, [])).history.length, 0);
    const pending = core.parseScrollCursor(cold.nextCursor, alice, 'postgres').pending;
    await admin.query("UPDATE app.content SET status='Draft' WHERE kind='video' AND id=$1", [pending[0]]);
    const all = [...cold.videos.map(item => item.id)];
    let cursor = cold.nextCursor;
    while (cursor) {
      const page = await service.listPersonalizedScroll(alice, cursor);
      assert(page.videos.length <= 8);
      all.push(...page.videos.map(item => item.id));
      cursor = page.nextCursor;
    }
    assert.equal(new Set(all).size, all.length);
    assert.equal(all.filter(id => ids.includes(id)).length, 51);
    assert(!all.includes(ids[52]));
    assert(!all.includes(pending[0]));
    await assert.rejects(service.listPersonalizedScroll(bob, cold.nextCursor), /INVALID_CURSOR/);
    await assert.rejects(reader.query('SELECT * FROM app.scroll_preferences'), /permission denied/);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const rights = await admin.query("SELECT has_table_privilege($1,'app.scroll_preferences','SELECT') AS allowed", [role]);
      assert.equal(rights.rows[0].allowed, false);
    }
  } finally {
    await admin.query('DELETE FROM app.scroll_preferences WHERE player_id=ANY($1)', [[alice, bob]]);
    await admin.query('DELETE FROM app.follows WHERE follower_id=$1', [alice]);
    await admin.query("DELETE FROM app.content WHERE kind='video' AND id=ANY($1)", [ids]);
    await reader.end(); await admin.end();
  }
});
