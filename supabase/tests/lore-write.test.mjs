// Run only against a disposable local PostgreSQL cluster.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';

const require = createRequire(import.meta.url);
const port = process.env.PGTEST_PORT;
function load(relative, mocks) {
  const file = new URL(relative, import.meta.url), mod = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: name => mocks[name] ?? require(name), Buffer, URL, process, console, Error }, { filename: file.pathname });
  return mod.exports;
}
class ContributionError extends Error { constructor(status) { super('Contribution error'); this.status = status; } }

test('lore writes, interactions, pagination, and role boundaries', { skip: !port }, async () => {
  const admin = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', database: 'postgres' });
  const reader = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'ambatu_dev_content_reader', database: 'postgres' });
  const db = { withDevLoreDb: async callback => {
    const client = await reader.connect();
    try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE ambatu_dev_lore_writer'); const result = await callback(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } };
  const service = load('../../src/lib/dev-lores.ts', { './community-content': { ContributionError },
    './community-contribution-validation': {}, './lore': { LORE_TEXT_LIMIT: 10000, validateLoreTranslations: () => {} },
    './s3-images': { isPlayerLoreImageKey: () => false, signedCharacterImageUrl: async () => null, deleteCharacterImage: async () => {} },
    './studio-content': { isStudioRoot: actor => actor?.roleId === 'root' },
    './character-list-pagination': load('../../src/lib/character-list-pagination.ts', {}), './dev-content-db': db });
  const interactions = load('../../src/lib/dev-lore-interactions.ts', { './dev-content-db': db,
    './lore-comment-cursor': load('../../src/lib/lore-comment-cursor.ts', {}),
    './profile-avatars': { profileAvatarUrl: async () => null }, './player-profiles': { fallbackPlayerName: () => 'Player' } });
  const owner = 'lore-test-owner', other = 'lore-test-other';
  const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab2'];
  const fields = { title: 'Test lore', text: 'Test text', tags: ['test'], translations: [], imageKeys: [] };
  let studioId;
  try {
    await Promise.all([service.createCreatorLore(owner, ids[0], fields, 'Draft'), service.createCreatorLore(owner, ids[0], fields, 'Draft')]);
    await assert.rejects(service.createCreatorLore(other, ids[0], fields, 'Draft'), error => error.status === 409);
    assert.equal((await reader.query("SELECT count(*)::int n FROM app.content WHERE kind='lore' AND id=$1", [ids[0]])).rows[0].n, 0);
    await assert.rejects(service.editCreatorLore(other, ids[0], fields), error => error.status === 404);
    await service.editCreatorLore(owner, ids[0], fields, 'Published');
    assert.equal((await reader.query("SELECT count(*)::int n FROM app.content WHERE kind='lore' AND id=$1", [ids[0]])).rows[0].n, 1);
    assert.equal((await Promise.all(Array.from({ length: 6 }, () => service.recordLoreView(ids[0], 'test-viewer', null)))).filter(Boolean).length, 1);
    assert.equal(await service.recordLoreView(ids[0], 'owner-view', owner), false);
    await service.createCreatorLore(owner, ids[1], fields, 'Draft');
    const first = await service.listCreatorLores(owner, new URL('http://test?limit=1'));
    const second = await service.listCreatorLores(owner, new URL(`http://test?limit=1&cursor=${first.nextCursor}`));
    assert.notEqual(first.lores[0].id, second.lores[0].id);
    await assert.rejects(service.listCreatorLores(other, new URL(`http://test?limit=1&cursor=${first.nextCursor}`)), error => error.status === 400);
    const comment = await interactions.createLoreComment(ids[0], { id: owner, email: 'test@example.com' }, 'first', null);
    const reply = await interactions.createLoreComment(ids[0], { id: other, email: 'test@example.com' }, 'reply', comment.id);
    await assert.rejects(interactions.createLoreComment(ids[0], { id: owner, email: '' }, 'bad', 'missing'), /Comment not found/);
    await Promise.all(Array.from({ length: 4 }, (_, i) => interactions.voteLore(ids[0], `voter-${i}`, 1)));
    assert.equal((await interactions.voteLore(ids[0], 'voter-0', 1)).upvotes, 3);
    assert.equal((await interactions.voteLore(ids[0], owner, -1, comment.id)).downvotes, 1);
    const page1 = await interactions.listLoreComments(ids[0], owner, new URL('http://test?limit=1'));
    const page2 = await interactions.listLoreComments(ids[0], owner, new URL(`http://test?limit=1&cursor=${page1.nextCursor}`));
    assert.equal(page1.comments[0].id, reply.id);
    assert.equal(page2.comments[0].id, comment.id);
    assert.equal(page2.comments[0].userVote, -1);
    await assert.rejects(interactions.listLoreComments(ids[1], owner, new URL(`http://test?cursor=${page1.nextCursor}`)));
    const stats = await service.loreInsights(owner);
    assert.equal(stats.views, 1); assert.equal(stats.upvotes, 3); assert.equal(stats.comments, 2);
    const editor = { sub: 'lore-test-editor', roleId: 'editor' }, otherEditor = { sub: 'lore-test-other-editor', roleId: 'editor' };
    studioId = (await service.createStudioLore(editor, { ...fields, status: 'Draft' })).id;
    assert.equal((await service.listStudioLores(editor, new URL('http://test?limit=1&q=Test'))).lores.length, 1);
    await assert.rejects(service.editStudioLore(otherEditor, studioId, fields), /forbidden/);
    assert.equal((await service.editStudioLore(editor, studioId, { status: 'Published' })).status, 'Published');
    await service.deleteStudioLore(editor, studioId);
    await service.deleteCreatorLore(owner, ids[0]);
    assert.equal((await admin.query("SELECT count(*)::int n FROM app.comments WHERE content_kind='lore' AND content_id=$1", [ids[0]])).rows[0].n, 0);
    const client = await reader.connect();
    try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE ambatu_dev_lore_writer');
      assert.equal((await client.query("SELECT count(*)::int n FROM app.content WHERE kind='video'")).rows[0].n, 0);
      await assert.rejects(client.query("INSERT INTO app.content (kind,id) VALUES ('video','denied')"), /row-level security/);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  } finally {
    await admin.query("DELETE FROM app.content WHERE kind='lore' AND id=ANY($1)", [[...ids, studioId].filter(Boolean)]);
    await reader.end(); await admin.end();
  }
});
