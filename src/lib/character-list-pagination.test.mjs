import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(relative, mocks = {}) {
  const filename = new URL(relative, import.meta.url), evaluatedModule = { exports: {} };
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { module: evaluatedModule, exports: evaluatedModule.exports, require: name => mocks[name] ?? require(name), Buffer, URL, Response, Request, process, Error }, { filename: filename.pathname });
  return evaluatedModule.exports;
}
test('Firestore studio character pages are bounded, filtered, scoped to owners, and use stable cursors', async () => {
  const rows = Array.from({ length: 45 }, (_, n) => ({ id: `id${String(n).padStart(2, '0')}`, name: n % 2 ? 'Target' : 'Other', title: 'Title', tags: ['test'], status: n % 3 ? 'Draft' : 'Published', createdBy: n < 35 ? 'owner' : 'other' }));
  const limits = [];
  const snapshot = data => ({ id: data.id, data: () => data });
  function query(owner = null, after = null, limit = null) {
    return { where: (_field, _operator, value) => query(value, after, limit), orderBy: () => query(owner, after, limit),
      startAfter: id => query(owner, id, limit), limit: n => query(owner, after, n),
      get: async () => { limits.push(limit); return { docs: rows.filter(item => (!owner || item.createdBy === owner) && (!after || item.id > after)).slice(0, limit).map(snapshot) }; } };
  }
  const pagination = load('./character-list-pagination.ts');
  const mocks = { 'next/server': { NextResponse: class extends Response { static json = Response.json; } },
    'firebase-admin/firestore': { FieldPath: { documentId: () => '__name__' }, FieldValue: {} },
    '../../../lib/dev-content-db': { isDevCharacterWriter: () => false }, '../../../lib/dev-characters': {},
    '../../../lib/firebase-admin': { adminDb: { collection: () => query() } },
    '../../../lib/api-auth': { requireAdmin: async () => ({ sub: 'owner', roleId: 'editor' }) },
    '../../../lib/studio-api': { adminErrorStatus: (_error, fallback) => fallback },
    '../../../lib/s3-images': { characterImageKey: () => undefined, signedCharacterImageUrl: async () => undefined },
    '../../../lib/studio-content': { isStudioRoot: actor => actor.roleId === 'root' },
    '../../../lib/character-list-pagination': pagination };
  const route = load('../app/api/characters/route.ts', mocks);
  const first = await (await route.GET(new Request('http://test/api/characters?limit=3&q=target&status=Draft'))).json();
  assert.equal(first.characters.length, 3);
  assert.ok(first.nextCursor);
  assert.ok(first.characters.every(item => item.name === 'Target' && item.status === 'Draft'));
  const next = await (await route.GET(new Request(`http://test/api/characters?limit=3&q=target&status=Draft&cursor=${first.nextCursor}`))).json();
  assert.equal(next.characters.length, 3);
  assert.ok(next.characters.every(item => !first.characters.some(prior => prior.id === item.id)));
  assert.ok(limits.every(limit => limit === 4));
  assert.equal((await route.GET(new Request(`http://test/api/characters?limit=3&q=other&cursor=${first.nextCursor}`))).status, 400);
  assert.ok([...first.characters, ...next.characters].every(item => Number(item.id.slice(2)) < 35));
});
