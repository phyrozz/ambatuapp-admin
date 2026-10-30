import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(relative, mocks = {}) {
  const filename = new URL(relative, import.meta.url);
  const evaluatedModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module: evaluatedModule, exports: evaluatedModule.exports, require: name => mocks[name] ?? require(name), Buffer, crypto, URL, Response, Request, process }, { filename: filename.pathname });
  return evaluatedModule.exports;
}
const owner = '11111111-1111-4111-8111-111111111111';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const soundKey = `soundboard/player_${owner}/${id}.mp3`;
const loreBody = { submissionId: id, title: 'Draft lore', text: 'A private story', tags: [], translations: [], imageKeys: [] };
const soundBody = { name: 'A private sound', category: 'Classics', soundKey };
class NextResponse extends Response {
  static json = Response.json;
  static redirect(url, options = {}) { return new Response(null, { ...options, headers: { ...options.headers, location: url } }); }
}

function fixture() {
  const records = { lores: new Map(), soundboardSounds: new Map() };
  function collection(name) {
    const map = records[name];
    const doc = key => ({ id: key, map, get: async () => snap(key), update: async fields => map.set(key, { ...map.get(key), ...fields }) });
    const snap = key => ({ id: key, exists: map.has(key), data: () => map.get(key) });
    function query(filters = [], sorts = [], limit = Infinity, after = null) {
      return {
        doc,
        where: (field, _op, value) => query([...filters, [field, value]], sorts, limit, after),
        orderBy: (field, direction) => query(filters, [...sorts, [field, direction]], limit, after),
        limit: value => query(filters, sorts, value, after),
        startAfter: (...values) => query(filters, sorts, limit, values),
        get: async () => {
          let keys = [...map.keys()].filter(key => filters.every(([field, value]) => map.get(key)[field] === value));
          keys.sort((a, b) => {
            for (const [field, direction] of sorts) {
              const first = field === '__name__' ? a : map.get(a)[field];
              const last = field === '__name__' ? b : map.get(b)[field];
              const comparison = String(first ?? '').localeCompare(String(last ?? ''));
              if (comparison) return direction === 'desc' ? -comparison : comparison;
            }
            return a.localeCompare(b);
          });
          if (after) { const key = typeof after[0] === 'object' ? after[0].id : after.at(-1); keys = keys.slice(keys.indexOf(key) + 1); }
          return { docs: keys.slice(0, limit).map(snap) };
        },
      };
    }
    return query();
  }
  const db = {
    collection,
    runTransaction: async work => work({
      get: ref => ref.get(),
      create: (ref, data) => ref.map.set(ref.id, data),
      update: (ref, fields) => ref.map.set(ref.id, { ...ref.map.get(ref.id), ...fields }),
      delete: ref => ref.map.delete(ref.id),
    }),
  };
  const auth = { requirePlayer: async request => { if (request.headers.get('authorization') !== 'owner') throw new Error('unauthorized'); return { id: owner }; }, playerFromRequest: async () => null };
  const common = load('./community-content.ts', { 'next/server': { NextResponse }, './firebase-admin': { adminDb: db }, './player-auth': auth, './public-write-limits': { allowPlayerWrite: async () => true } });
  const images = { signedCharacterImageUrl: async () => null, isPlayerLoreImageKey: () => true, verifyPlayerLoreImage: async () => {}, deleteCharacterImage: async () => {} };
  const validation = load('./community-contribution-validation.ts', { './community-content': common, './lore': { LORE_TEXT_LIMIT: 200000, validateLoreTranslations: () => {} }, './s3-images': images });
  const sounds = load('./admin-sounds.ts');
  const storage = {
    adminSoundUploadKey: (key, player) => { if (typeof key !== 'string' || !key.startsWith(`soundboard/${player}/`)) throw new Error('foreign key'); return key; },
    verifySoundUpload: async () => {}, deleteSoundUpload: async () => {},
    signedSoundUrl: async key => `https://private.example.test/${key}?signed=owner`,
    validSoundAssetKey: key => typeof key === 'string' && key.startsWith('soundboard/'),
  };
  function route(path) {
    const filename = `../app/api/public/${path}/route.ts`;
    const imports = [...readFileSync(new URL(filename, import.meta.url), 'utf8').matchAll(/from ['"]([^'"]+)['"]/g)].map(match => match[1]);
    const mocks = { 'next/server': { NextResponse }, 'firebase-admin/firestore': { FieldPath: { documentId: () => '__name__' }, FieldValue: { serverTimestamp: () => null, increment: value => value } } };
    const libraries = { 'firebase-admin': { adminDb: db }, 'dev-content-db': { isDevContentSnapshot: () => false, isDevCharacterWriter: () => false, isDevLoreWriter: () => false, isDevSoundWriter: () => false }, 'dev-content-read': {}, 'dev-characters': {}, 'dev-lores': {}, 'dev-sounds': {}, 'dev-lore-interactions': {}, 'community-content': common, 'community-contribution-validation': validation, lore: { LORE_TEXT_LIMIT: 200000, validateLoreTranslations: () => {} }, 's3-images': images, 'admin-sounds': sounds, 's3-sounds': storage, 'player-auth': auth, 'public-write-limits': { allowPlayerWrite: async () => true }, 'player-profiles': { playerDisplayProfiles: async () => new Map() } };
    for (const name of imports) { const library = name.split('/').at(-1); if (libraries[library]) mocks[name] = libraries[library]; }
    return load(filename, mocks);
  }
  const request = (method = 'GET', body, authHeader = 'owner', query = '') => new Request(`http://test/api${query}`, { method, headers: { authorization: authHeader, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const params = key => ({ params: Promise.resolve({ id: key }) });
  return { records, route, request, params, common };
}

for (const kind of ['lores', 'sounds']) {
  test(`${kind}: private draft creation, owner editing, publication and ownership checks`, async () => {
    const { records, route, request, params } = fixture();
    const map = records[kind === 'lores' ? 'lores' : 'soundboardSounds'];
    const body = kind === 'lores' ? loreBody : soundBody;
    const create = route(`contributions/${kind}`);
    const edit = route(`contributions/${kind}/[id]`);
    assert.equal((await create.POST(request('POST', { ...body, status: 'Draft' }, 'invalid'))).status, 401);
    assert.equal((await create.POST(request('POST', { ...body, status: 'Draft' }))).status, 201);
    assert.equal(map.get(id).status, 'Draft');
    const own = await (await create.GET(request())).json();
    assert.equal(own[kind][0].status, 'Draft');
    if (kind === 'sounds') assert.match(own.sounds[0].file, /signed=owner/);
    assert.equal((await route(`${kind}/[id]`).GET(request(), params(id))).status, 404);
    if (kind === 'sounds') {
      assert.equal((await route('sounds/[id]/audio').GET(request(), params(id))).status, 404);
      assert.equal((await route('sounds/[id]/plays').POST(request('POST', { visitorId: owner }), params(id))).status, 404);
    }
    assert.equal((await edit.PATCH(request('PATCH', body), params(id))).status, 200);
    assert.equal(map.get(id).status, 'Draft', 'omitting status must preserve drafts');
    assert.equal((await edit.PATCH(request('PATCH', { ...body, status: 'Published' }), params(id))).status, 200);
    assert.equal(map.get(id).status, 'Published');
    assert.equal((await route(`${kind}/[id]`).GET(request(), params(id))).status, 200);
    assert.equal((await edit.PATCH(request('PATCH', { ...body, status: 'Draft' }), params(id))).status, 200);
    assert.equal(map.get(id).status, 'Draft');
    map.set(id, { ...map.get(id), uploaderId: 'another-player' });
    assert.equal((await edit.PATCH(request('PATCH', { ...body, status: 'Published' }), params(id))).status, 404);
    assert.equal(map.get(id).status, 'Draft');
    assert.equal((await create.POST(request('POST', { ...body, status: 'Invalid' }))).status, 400);
  });
}

test('public sound pagination skips drafts without losing its cursor; legacy sounds stay public', async () => {
  const { records, route, request, params } = fixture();
  records.soundboardSounds.set(id, { ...soundBody, name: 'A draft', status: 'Draft' });
  records.soundboardSounds.set(second, { ...soundBody, name: 'B legacy' });
  const catalog = route('sounds');
  const first = await (await catalog.GET(request('GET', undefined, 'owner', '?limit=1'))).json();
  assert.equal(first.sounds.length, 0);
  assert.ok(first.nextCursor);
  const last = await (await catalog.GET(request('GET', undefined, 'owner', `?limit=1&cursor=${first.nextCursor}`))).json();
  assert.equal(last.sounds[0].id, second);
  assert.equal(last.nextCursor, null);
  assert.equal((await route('sounds/[id]').GET(request(), params(second))).status, 200);
  assert.equal((await route('sounds/[id]/audio').GET(request(), params(second))).status, 302);
  const all = await (await catalog.GET(request())).json();
  assert.equal(all.sounds.length, 1);
});

test('public lore catalog excludes private drafts', async () => {
  const { records, route, request } = fixture();
  records.lores.set(id, { ...loreBody, status: 'Draft' });
  records.lores.set(second, { ...loreBody, title: 'Public story', status: 'Published' });
  const catalog = await (await route('lores').GET(request())).json();
  assert.equal(catalog.lores.length, 1);
  assert.equal(catalog.lores[0].id, second);
});
