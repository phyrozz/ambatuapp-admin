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
test('video ownership, drafts, interactions, scroll, clips, and role isolation', { skip: !port }, async () => {
  const admin = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', database: 'postgres' });
  const reader = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'ambatu_dev_content_reader', database: 'postgres' });
  const db = { withDevVideoDb: async callback => {
    const client = await reader.connect();
    try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE ambatu_dev_video_writer'); const result = await callback(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } };
  const profile = { profileAvatarUrl: async () => null }, players = { fallbackPlayerName: () => 'Player' };
  const videos = load('../../src/lib/dev-videos.ts', { './dev-content-db': db, './admin-video': { deleteVideoAssets: async () => {} },
    './s3-videos': { signedVideoUrl: async key => `https://example.test/${key}` }, './studio-content': { isStudioRoot: actor => !actor || actor.roleId === 'root' },
    './character-list-pagination': load('../../src/lib/character-list-pagination.ts', {}), './profile-avatars': profile, './player-profiles': players });
  const interactions = load('../../src/lib/dev-video-interactions.ts', { './dev-content-db': db, './lore-comment-cursor': load('../../src/lib/lore-comment-cursor.ts', {}), './profile-avatars': profile, './player-profiles': players });
  const owner = 'video-test-owner', other = 'video-test-other', assetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaacc';
  const keys = { videoKey: `videos/${owner}/${assetId}.mp4`, thumbnailKey: `video-thumbnails/${owner}/${assetId}.jpg` };
  const fields = { title: 'Test video', description: 'Test description', status: 'Published' }, ids = [];
  try {
    const created = await videos.createVideo(fields, keys, { uploaderId: owner, name: 'Test owner', email: 'test@example.com' }); ids.push(created.id);
    assert.equal(await videos.editPlayerVideo(other, created.id, 'wrong', ''), false);
    assert.equal(await videos.editPlayerVideo(owner, created.id, 'updated', ''), true);
    const comment = await interactions.createVideoComment(created.id, { id: owner, email: 'test@example.com' }, 'first', null);
    const reply = await interactions.createVideoComment(created.id, { id: other, email: 'test@example.com' }, 'reply', comment.id);
    await assert.rejects(interactions.createVideoComment(created.id, { id: owner, email: '' }, 'bad', 'missing'), /Comment not found/);
    await Promise.all(Array.from({ length: 4 }, (_, i) => interactions.voteVideo(created.id, `voter-${i}`, 1)));
    assert.equal((await interactions.voteVideo(created.id, 'voter-0', 1)).upvotes, 3);
    assert.equal((await interactions.voteVideo(created.id, owner, -1, comment.id)).downvotes, 1);
    const page1 = await interactions.listVideoComments(created.id, owner, new URL('http://test?limit=1'));
    const page2 = await interactions.listVideoComments(created.id, owner, new URL(`http://test?limit=1&cursor=${page1.nextCursor}`));
    assert.equal(page1.comments[0].id, reply.id); assert.equal(page2.comments[0].id, comment.id); assert.equal(page2.comments[0].userVote, -1);
    assert.equal((await videos.getScrollVideo('voter-1', created.id)).userVote, 1);
    assert.equal((await videos.listCreatorClips(owner, owner, null)).clips[0].id, created.id);
    assert.equal((await videos.listScrollVideos(owner, null)).videos.some(item => item.id === created.id), true);
    for (let i = 0; i < 13; i++) ids.push((await videos.createVideo(fields, keys, { uploaderId: owner, name: 'Test owner', email: 'test@example.com' })).id);
    const scrollFirst = await videos.listScrollVideos(owner, null);
    assert.equal(scrollFirst.videos.length, 8); assert.ok(scrollFirst.nextCursor);
    const scrollSecond = await videos.listScrollVideos(owner, scrollFirst.nextCursor);
    assert.equal(scrollSecond.videos.some(item => scrollFirst.videos.some(first => first.id === item.id)), false);
    const clipsFirst = await videos.listCreatorClips(owner, owner, null);
    assert.equal(clipsFirst.clips.length, 12); assert.ok(clipsFirst.nextCursor);
    const clipsSecond = await videos.listCreatorClips(owner, owner, clipsFirst.nextCursor);
    assert.equal(clipsSecond.clips.some(item => clipsFirst.clips.some(first => first.id === item.id)), false);
    assert.equal(await videos.creatorClipCount(owner, true), 14);
    assert.equal(await videos.creatorClipCount(owner, false), 14);
    await assert.rejects(videos.listCreatorClips(owner, other, clipsFirst.nextCursor), /INVALID_CURSOR/);
    const editor = { sub: 'video-test-editor', roleId: 'editor' }, another = { sub: 'video-test-other', roleId: 'editor' };
    const studio = await videos.createStudioVideo(editor, { ...fields, status: 'Draft' }, keys); ids.push(studio.id);
    assert.equal((await videos.listStudioVideos(editor, new URL('http://test?limit=1'))).videos[0].id, studio.id);
    assert.equal(await videos.getScrollVideo(owner, studio.id), null);
    assert.equal(await videos.editStudioVideo(another, studio.id, fields), null);
    assert.equal((await videos.editStudioVideo(editor, studio.id, fields)).status, 'Published');
    assert.equal(await videos.deleteManagedVideo(studio.id, another), false);
    assert.equal(await videos.deleteManagedVideo(studio.id, editor), true);
    assert.equal(await videos.deleteManagedVideo(created.id, undefined, other), false);
    assert.equal(await videos.deleteManagedVideo(created.id, undefined, owner), true);
    assert.equal((await admin.query("SELECT count(*)::int n FROM app.comments WHERE content_kind='video' AND content_id=$1", [created.id])).rows[0].n, 0);
    const client = await reader.connect();
    try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE ambatu_dev_video_writer');
      assert.equal((await client.query("SELECT count(*)::int n FROM app.content WHERE kind='lore'")).rows[0].n, 0);
      await assert.rejects(client.query("INSERT INTO app.content (kind,id) VALUES ('lore','denied')"), /row-level security/);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  } finally {
    await admin.query("DELETE FROM app.content WHERE kind='video' AND id=ANY($1)", [ids]);
    await reader.end(); await admin.end();
  }
});
