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
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: name => mocks[name] ?? require(name), Buffer, URL, process, console, Error, Date }, { filename: file.pathname });
  return mod.exports;
}
test('profiles reserve names atomically and coordinate avatar moderation', { skip: !port }, async () => {
  const admin = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', database: 'postgres' });
  const reader = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'ambatu_dev_content_reader', database: 'postgres' });
  const db = { withDevProfileDb: async callback => {
    const client = await reader.connect();
    try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE ambatu_dev_profile_writer'); const result = await callback(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } };
  const deleted = [];
  const profiles = load('../../src/lib/dev-profiles.ts', { './dev-content-db': db, './creator-search': load('../../src/lib/creator-search.ts', {}),
    './profile-avatars': { profileAvatarUrl: async key => key ? `https://example.test/${key}` : null, bestEffortDeleteProfileAvatar: async key => { deleted.push(key); } } });
  const alice = 'profile-test-alice', bob = 'profile-test-bob', preset = 'profile-test-preset';
  try {
    const first = await profiles.initializeProfile(alice, 'alice@example.test', 'hash-alice');
    assert.ok(first.username.startsWith('thughunter_'));
    assert.equal((await profiles.initializeProfile(alice, 'alice@example.test', 'hash-alice')).username, first.username);
    await profiles.initializeProfile(bob, 'bob@example.test', 'hash-bob');
    const attempts = await Promise.allSettled([
      profiles.updateProfile(alice, 'Shared Test', '2001-02-03', 'hello', 'hash-alice'),
      profiles.updateProfile(bob, 'Shared Test', null, undefined, 'hash-bob'),
    ]);
    assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter(item => item.status === 'rejected' && item.reason.message === 'USERNAME_TAKEN').length, 1);
    const winner = attempts[0].status === 'fulfilled' ? alice : bob;
    assert.equal((await profiles.searchProfiles('username', 'shared', null))[0].id, winner);
    assert.equal((await profiles.searchProfiles('email', 'hash-alice', null))[0].id, alice);
    assert.equal((await profiles.searchProfiles('username', 'shared', { name: 'shared test', id: winner })).length, 0);
    const publicProfile = await profiles.getProfilePublic(alice);
    assert.equal('birthDate' in publicProfile, false); assert.equal('emailSearchHash' in publicProfile, false);
    await profiles.addPreset(preset, 'Test preset', 'preset-key', 'image/jpeg');
    await profiles.choosePreset(alice, preset);
    assert.equal((await profiles.getProfile(alice, '')).avatarId, preset);
    await assert.rejects(profiles.deletePreset(preset), error => error.status === 409);
    await profiles.setCustomAvatar(alice, 'alice@example.test', 'custom-key');
    assert.equal((await profiles.listCustomAvatars()).some(row => row.userId === alice), true);
    await profiles.removeCustomAvatar(alice);
    assert.equal((await profiles.getProfile(alice, '')).avatarRemoved, true);
    assert.ok(deleted.includes('custom-key'));
    await profiles.deletePreset(preset);
    await profiles.addPreset(preset, 'Race preset', 'race-key', 'image/jpeg');
    const race = await Promise.allSettled([profiles.choosePreset(bob, preset), profiles.deletePreset(preset)]);
    assert.equal(race.filter(item => item.status === 'fulfilled').length, 1);
    const selected = (await profiles.getProfile(bob, '')).avatarId;
    if (selected === preset) { await profiles.choosePreset(bob, null); await profiles.deletePreset(preset); }
    await profiles.profileActivity(alice);
    assert.equal((await admin.query('SELECT last_active_at IS NOT NULL AS active FROM app.player_profiles WHERE id=$1', [alice])).rows[0].active, true);
    const client = await reader.connect();
    try { await client.query('BEGIN'); await assert.rejects(client.query('SELECT birth_date FROM app.player_profiles LIMIT 1'), /permission denied/); await client.query('ROLLBACK'); }
    finally { client.release(); }
  } finally {
    await admin.query('DELETE FROM app.username_claims WHERE player_id=ANY($1)', [[alice, bob]]);
    await admin.query('DELETE FROM app.avatar_moderation WHERE player_id=ANY($1)', [[alice, bob]]);
    await admin.query('DELETE FROM app.player_profiles WHERE id=ANY($1)', [[alice, bob]]);
    await admin.query('DELETE FROM app.profile_avatars WHERE id=$1', [preset]);
    await reader.end(); await admin.end();
  }
});
