// A disposable LOCAL PostgreSQL cluster is required. Never run against Supabase.
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
  const file = new URL(relative, import.meta.url), evaluatedModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module: evaluatedModule, exports: evaluatedModule.exports, require: name => mocks[name] ?? require(name), Buffer, URL, process, console, Request, Response, Error }, { filename: file.pathname });
  return evaluatedModule.exports;
}
class ContributionError extends Error { constructor(status) { super('Contribution request failed'); this.status = status; } }

test('character transactions enforce ownership, publication, view uniqueness, and role boundaries', { skip: !port }, async () => {
  const admin = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', database: 'postgres' });
  const reader = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'ambatu_dev_content_reader', database: 'postgres' });
  const storage = { isPlayerCharacterImageKey: () => false, signedCharacterImageUrl: async () => undefined,
    characterImageKey: key => key, verifyPlayerCharacterImage: async () => {}, deleteCharacterImage: async () => {} };
  const player = load('../../src/lib/player-character.ts', { './community-content': { ContributionError }, './s3-images': storage });
  const pagination = load('../../src/lib/character-list-pagination.ts', {});
  const db = { withDevCharacterDb: async callback => {
    const client = await reader.connect();
    try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE ambatu_dev_character_writer'); const result = await callback(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } };
  const service = load('../../src/lib/dev-characters.ts', { './community-content': { ContributionError }, './player-character': player,
    './s3-images': storage, './studio-content': { isStudioRoot: actor => actor?.roleId === 'root' },
    './dev-content-db': db, './character-list-pagination': pagination });
  const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
  const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'];
  const draft = { name: 'Test character', title: 'Test title', bio: 'Test bio', tags: ['test'], status: 'Draft', imageKey: null };
  try {
    await Promise.all([service.createCreatorCharacter(owner, ids[0], draft), service.createCreatorCharacter(owner, ids[0], draft)]);
    assert.equal((await admin.query("SELECT count(*)::int n FROM app.content WHERE kind='character' AND id=$1", [ids[0]])).rows[0].n, 1);
    await assert.rejects(service.createCreatorCharacter(other, ids[0], draft), error => error.status === 409);
    assert.equal((await reader.query("SELECT count(*)::int n FROM app.content WHERE kind='character' AND id=$1", [ids[0]])).rows[0].n, 0);
    await assert.rejects(service.editCreatorCharacter(other, ids[0], { ...draft, status: 'Published' }), error => error.status === 404);
    await service.editCreatorCharacter(owner, ids[0], { ...draft, status: 'Published' });
    assert.equal((await reader.query("SELECT count(*)::int n FROM app.content WHERE kind='character' AND id=$1", [ids[0]])).rows[0].n, 1);
    assert.equal(await service.recordCharacterView(ids[0], 'owner-hash', owner), false);
    const views = await Promise.all(Array.from({ length: 8 }, () => service.recordCharacterView(ids[0], 'visitor-hash', null)));
    assert.equal(views.filter(Boolean).length, 1);
    assert.equal((await admin.query("SELECT view_count FROM app.content WHERE kind='character' AND id=$1", [ids[0]])).rows[0].view_count, '1');
    await service.createCreatorCharacter(owner, ids[1], draft);
    const first = await service.listCreatorCharacters(owner, new URL('http://test?limit=1'));
    assert.equal(first.characters.length, 1); assert.ok(first.nextCursor);
    const second = await service.listCreatorCharacters(owner, new URL(`http://test?limit=1&cursor=${first.nextCursor}`));
    assert.notEqual(first.characters[0].id, second.characters[0].id);
    await assert.rejects(service.listCreatorCharacters(other, new URL(`http://test?limit=1&cursor=${first.nextCursor}`)), error => error.status === 400);
    const insights = await service.characterInsights(owner);
    assert.equal(insights.views, 1); assert.equal(insights.published, 1); assert.equal(insights.drafts, 1);
    const common = { ContributionError, contributionHeaders: {}, contributionBody: request => request.json(),
      contributionPlayer: async request => { const id = request.headers.get('authorization'); if (!id) throw new ContributionError(401); return { id }; },
      contributionError: error => Response.json({ error: 'failed' }, { status: error.status ?? 400 }), limitContribution: async () => {} };
    const next = { NextResponse: class extends Response { static json = Response.json; } };
    const mocks = prefix => ({ 'next/server': next, 'firebase-admin/firestore': { FieldPath: {}, FieldValue: {} },
      [`${prefix}/dev-content-db`]: { isDevCharacterWriter: () => true }, [`${prefix}/dev-characters`]: service,
      [`${prefix}/firebase-admin`]: { adminDb: {} }, [`${prefix}/community-content`]: common,
      [`${prefix}/player-character`]: player, [`${prefix}/s3-images`]: storage });
    const collectionRoute = load('../../src/app/api/public/contributions/characters/route.ts', mocks('../../../../../lib'));
    const itemRoute = load('../../src/app/api/public/contributions/characters/[id]/route.ts', mocks('../../../../../../lib'));
    const request = (method, body, id = owner) => new Request('http://test/api', { method, headers: { authorization: id, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await collectionRoute.POST(request('POST', { ...draft, submissionId: ids[2] }))).status, 201);
    assert.equal((await collectionRoute.POST(request('POST', { ...draft, submissionId: ids[2] }, other))).status, 409);
    assert.equal((await itemRoute.PATCH(request('PATCH', { ...draft, status: 'Published' }, other), { params: Promise.resolve({ id: ids[2] }) })).status, 404);
    assert.equal((await itemRoute.PATCH(request('PATCH', { ...draft, status: 'Published' }), { params: Promise.resolve({ id: ids[2] }) })).status, 200);
    assert.equal((await reader.query("SELECT count(*)::int n FROM app.content WHERE kind='character' AND id=$1", [ids[2]])).rows[0].n, 1);
    await service.deleteStudioCharacter({ sub: 'root-test', roleId: 'root' }, ids[0]);
    assert.equal((await admin.query("SELECT count(*)::int n FROM app.content_visitors WHERE content_kind='character' AND content_id=$1", [ids[0]])).rows[0].n, 0);
    const editor = { sub: 'studio-editor-test', roleId: 'editor' }, another = { sub: 'another-editor', roleId: 'editor' };
    const created = await service.createStudioCharacter(editor, draft);
    assert.equal((await service.listStudioCharacters(editor, new URL('http://test?limit=1&q=Test'))).characters.length, 1);
    assert.equal((await service.listStudioCharacters(another, new URL('http://test?limit=1&q=Test'))).characters.length, 0);
    await assert.rejects(service.editStudioCharacter(another, created.id, draft), /forbidden/);
    assert.equal((await service.editStudioCharacter(editor, created.id, { ...draft, status: 'Published' })).status, 'Published');
    await service.deleteStudioCharacter(editor, created.id);
    assert.equal((await admin.query("SELECT count(*)::int n FROM app.content WHERE kind='character' AND id=$1", [created.id])).rows[0].n, 0);
    const client = await reader.connect();
    try {
      await client.query('BEGIN'); await client.query('SET LOCAL ROLE ambatu_dev_character_writer');
      assert.equal((await client.query("SELECT count(*)::int n FROM app.content WHERE kind='video'")).rows[0].n, 0);
      await assert.rejects(client.query("INSERT INTO app.content (kind,id) VALUES ('video','denied')"), /row-level security/);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  } finally {
    await admin.query("DELETE FROM app.content WHERE kind='character' AND id=ANY($1)", [ids]);
    await reader.end(); await admin.end();
  }
});
