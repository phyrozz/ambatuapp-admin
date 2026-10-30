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
class ContributionError extends Error { constructor(status) { super('Contribution error'); this.status = status; } }
test('sound drafts, ownership, playback, listener uniqueness, and permissions', { skip: !port }, async () => {
  const admin = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', database: 'postgres' });
  const reader = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'ambatu_dev_content_reader', database: 'postgres' });
  const db = { withDevSoundDb: async callback => {
    const client = await reader.connect();
    try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE ambatu_dev_sound_writer'); const result = await callback(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } };
  const sounds = load('../../src/lib/admin-sounds.ts', {});
  const storage = { adminSoundUploadKey: (key, owner) => { if (typeof key !== 'string' || !key.startsWith(`${owner}/`)) throw new Error('invalid key'); return key; },
    deleteSoundUpload: async () => {}, signedSoundUrl: async key => `https://example.test/${key}`, validSoundAssetKey: key => typeof key === 'string', verifySoundUpload: async () => {} };
  const service = load('../../src/lib/dev-sounds.ts', { './community-content': { ContributionError }, './admin-sounds': sounds, './s3-sounds': storage,
    './studio-content': { isStudioRoot: actor => actor?.roleId === 'root' }, './character-list-pagination': load('../../src/lib/character-list-pagination.ts', {}), './dev-content-db': db });
  const owner = 'sound-test-owner', other = 'sound-test-other';
  const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac2'];
  const fields = { name: 'Test sound', category: 'Test' }, key = `player_${owner}/test.mp3`;
  let studioId;
  try {
    await Promise.all([service.createCreatorSound(owner, ids[0], fields, 'Draft', key), service.createCreatorSound(owner, ids[0], fields, 'Draft', key)]);
    await assert.rejects(service.createCreatorSound(other, ids[0], fields, 'Draft', key), error => error.status === 409);
    assert.equal(await service.publicSoundKey(ids[0]), null);
    await assert.rejects(service.editCreatorSound(other, ids[0], fields, 'Published', undefined), error => error.status === 404);
    await service.editCreatorSound(owner, ids[0], fields, 'Published', undefined);
    assert.equal(await service.publicSoundKey(ids[0]), key);
    await Promise.all(Array.from({ length: 8 }, () => service.recordSoundPlay(ids[0], 'same-listener', null)));
    await service.recordSoundPlay(ids[0], 'owner-listener', owner);
    const stats = await service.soundInsights(owner);
    assert.equal(stats.plays, 9); assert.equal(stats.listeners, 1); assert.equal(stats.published, 1);
    await service.createCreatorSound(owner, ids[1], fields, 'Draft', key);
    const first = await service.listCreatorSounds(owner, new URL('http://test?limit=1'));
    const second = await service.listCreatorSounds(owner, new URL(`http://test?limit=1&cursor=${first.nextCursor}`));
    assert.notEqual(first.sounds[0].id, second.sounds[0].id);
    await assert.rejects(service.listCreatorSounds(other, new URL(`http://test?limit=1&cursor=${first.nextCursor}`)), error => error.status === 400);
    const editor = { sub: 'sound-test-editor', roleId: 'editor' };
    studioId = (await service.createStudioSound(editor, fields, 'studio/test.mp3', null, 'http://test')).id;
    assert.equal((await service.listStudioSounds(editor, new URL('http://test?limit=1'))).sounds[0].id, studioId);
    assert.equal(await service.publicSoundKey(studioId), 'studio/test.mp3');
    await service.deleteCreatorSound(owner, ids[0]);
    assert.equal((await admin.query("SELECT count(*)::int n FROM app.content_visitors WHERE content_kind='sound' AND content_id=$1", [ids[0]])).rows[0].n, 0);
    const client = await reader.connect();
    try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE ambatu_dev_sound_writer');
      assert.equal((await client.query("SELECT count(*)::int n FROM app.content WHERE kind='video'")).rows[0].n, 0);
      await assert.rejects(client.query("INSERT INTO app.content (kind,id) VALUES ('video','denied')"), /row-level security/);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  } finally {
    await admin.query("DELETE FROM app.content WHERE kind='sound' AND id=ANY($1)", [[...ids, studioId].filter(Boolean)]);
    await reader.end(); await admin.end();
  }
});
