import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
function fixture() {
  const blocked = new Set(['bob']);
  const load = filename => {
    const module = { exports: {} };
    const code = ts.transpileModule(readFileSync(path.join(root, filename), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    class NextResponse extends Response { static json(body, init) { return new NextResponse(JSON.stringify(body), init); } }
    const mocks = {
      'next/server': { NextResponse },
      '/player-auth': { requirePlayer: async request => { if (request.headers.get('authorization') !== 'Bearer alice') throw new Error('UNAUTHORIZED'); return { id: 'alice' }; } },
      '/dev-content-db': { isDevProfileWriter: () => true, isDevSocialWriter: () => true, isDevVideoWriter: () => true },
      '/player-blocks': {
        hiddenPlayerIds: async (_viewer, ids) => new Set(ids.filter(id => blocked.has(id))),
        changePlayerBlock: async (_viewer, id, value) => { if (value) blocked.add(id); else blocked.delete(id); return { blocked: value }; },
        listPlayerBlocks: async () => ({ items: [...blocked].map(id => ({ id })), nextCursor: null }),
      },
      '/friend-list': { validFriendId: id => typeof id === 'string' && /^[\w-]{1,128}$/.test(id) },
      '/dev-profiles': { getExplicitProfiles: async ids => ids.map(id => ({ id, username: id, avatar_key: 'avatar' })), getProfilePublic: async id => ({ id, username: id }) },
      '/firebase-admin': { adminDb: null },
      '/profile-avatars': { profileAvatarUrl: async () => 'https://fixture.invalid/avatar' },
      '/player-profiles': { playerDisplayProfiles: async ids => new Map(ids.map(id => [id, { username: id, avatarUrl: null }])) },
      '/dev-social': { socialCounts: async () => ({ followers: 0, friends: 0, following: false, state: null }), friendRelationships: async () => new Map() },
      '/dev-videos': { creatorClipCount: async () => 0 },
    };
    const dep = name => { const key = Object.keys(mocks).find(key => name.endsWith(key)); if (!key) throw new Error(`Unmocked ${name}`); return mocks[key]; };
    vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { Response, Request, URL, Buffer, console, Date, Set, Map, Error })(dep, module, module.exports);
    return module.exports;
  };
  const request = (pathname, body, token = 'alice') => new Request(`https://fixture.invalid/api/public${pathname}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { blocked, load, request };
}

test('block endpoints reject unauthenticated/self requests and support idempotent unblock', async () => {
  const f = fixture(), route = f.load('app/api/public/blocks/[id]/route.ts'), params = id => ({ params: Promise.resolve({ id }) });
  assert.equal((await route.PUT(f.request('/blocks/bob', null, 'invalid'), params('bob'))).status, 401);
  assert.equal((await route.PUT(f.request('/blocks/alice'), params('alice'))).status, 400);
  assert.equal((await route.DELETE(f.request('/blocks/bob'), params('bob'))).status, 200);
  assert.equal((await route.DELETE(f.request('/blocks/bob'), params('bob'))).status, 200);
  const response = await route.PUT(f.request('/blocks/bob'), params('bob'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal((await response.json()).blocked, true);
});
test('batch names never returns a blocked name/avatar and invalid credentials cannot downgrade', async () => {
  const f = fixture(), route = f.load('app/api/public/players/names/route.ts');
  const response = await route.POST(f.request('/players/names', { ids: ['bob','carol'] }));
  assert.deepEqual(await response.json(), { names: { carol: 'carol' }, avatars: { carol: 'https://fixture.invalid/avatar' }, blocked: ['bob'] });
  assert.equal((await route.POST(f.request('/players/names', { ids: ['bob'] }, 'invalid'))).status, 401);
  assert.equal((await route.POST(f.request('/players/names', { ids: Array(101).fill('carol') }))).status, 400);
});
test('direct friend and creator profile reads cannot bypass a block', async () => {
  const f = fixture();
  const response = await f.load('app/api/public/friends/[id]/route.ts').GET(f.request('/friends/bob'), { params: Promise.resolve({ id: 'bob' }) });
  assert.equal(response.status, 404);
  const creator = f.load('lib/creator-profile.ts');
  await assert.rejects(creator.creatorProfile(null, 'bob', 'alice'), /PLAYER_NOT_FOUND/);
  assert.equal((await creator.creatorProfile(null, 'carol', 'alice')).id, 'carol');
});

test('enabled blocking cannot silently fall back to legacy profile access', async () => {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(path.join(root, 'lib/player-blocks.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const dependency = () => ({ isDevSocialWriter: () => false });
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { process: { env: { PLAYER_BLOCKS_ENABLED: 'true' } }, Set, Error })(dependency, module, module.exports);
  await assert.rejects(module.exports.hiddenPlayerIds('alice', ['bob']), /BLOCKS_UNAVAILABLE/);
  assert.equal((await module.exports.hiddenPlayerIds(null, ['bob'])).size, 0);
});
