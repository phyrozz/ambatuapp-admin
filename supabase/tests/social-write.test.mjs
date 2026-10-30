// Only run against a disposable local PostgreSQL database.
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
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: name => mocks[name] ?? require(name), Buffer, URL, process, console, Error }, { filename: file.pathname });
  return mod.exports;
}
test('friendship and follow transitions stay reciprocal under concurrent requests', { skip: !port }, async () => {
  const admin = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', database: 'postgres' });
  const reader = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'ambatu_dev_content_reader', database: 'postgres' });
  const db = { withDevSocialDb: async callback => {
    const client = await reader.connect();
    try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE ambatu_dev_social_writer'); const result = await callback(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } };
  const service = load('../../src/lib/dev-social.ts', { './dev-content-db': db,
    './friend-state': load('../../src/lib/friend-state.ts', {}), './follow-state': load('../../src/lib/follow-state.ts', {}), './friend-list': load('../../src/lib/friend-list.ts', {}) });
  const alice = 'social-test-alice', bob = 'social-test-bob';
  try {
    const requests = await Promise.all(Array.from({ length: 6 }, () => service.changeFollow(alice, bob, 'follow')));
    assert.equal(requests.filter(result => result.notify).length, 1);
    assert.equal((await service.socialCounts(bob, alice)).followers, 1);
    assert.equal((await service.socialCounts(bob, alice)).state, 'outgoing');
    assert.equal((await service.socialCounts(bob, bob)).incoming, 1);
    await assert.rejects(service.changeFriend(alice, bob, 'accept'), /INVALID_FRIEND_TRANSITION/);
    await service.changeFriend(bob, alice, 'accept');
    await service.changeFriend(alice, bob, 'pin');
    assert.equal((await service.friendRelationships(alice, [bob])).get(bob).pinned, true);
    assert.equal((await service.friendRelationships(bob, [alice])).get(alice).pinned, false);
    const filtered = await service.listFriends(alice, { state: 'accepted', pinned: true }, null);
    assert.equal(filtered.rows[0].other_player_id, bob);
    await service.changeFollow(alice, bob, 'unfollow');
    assert.equal((await service.socialCounts(bob, alice)).friends, 1);
    assert.equal((await service.socialCounts(bob, alice)).following, false);
    await service.changeFriend(alice, bob, 'remove');
    assert.equal((await service.friendRelationships(bob, [alice])).size, 0);
    await service.changeFollow(alice, bob, 'follow');
    await service.changeFollow(alice, bob, 'unfollow');
    assert.equal((await service.friendRelationships(bob, [alice])).size, 0);
    const client = await reader.connect();
    try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE ambatu_dev_social_writer');
      await assert.rejects(client.query('SELECT * FROM app.player_profiles'), /permission denied/);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  } finally {
    await admin.query('DELETE FROM app.friendships WHERE player_id=ANY($1) OR other_player_id=ANY($1)', [[alice, bob]]);
    await admin.query('DELETE FROM app.follows WHERE follower_id=ANY($1) OR followed_id=ANY($1)', [[alice, bob]]);
    await reader.end(); await admin.end();
  }
});
