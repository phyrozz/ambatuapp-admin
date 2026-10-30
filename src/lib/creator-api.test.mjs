// Execute the real route handlers against an isolated in-memory Firestore fixture.
// No Firebase credentials, Cognito calls, signed production URLs, or push sends.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
class Timestamp {
  constructor(seconds, nanoseconds = 0) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
  toDate() { return new Date(this.seconds * 1000); }
}
class NextResponse extends Response {
  static json(value, options) { return new NextResponse(JSON.stringify(value), options); }
}
const valueOf = value => value instanceof Timestamp ? value.seconds * 1e9 + value.nanoseconds : value;

function fixture() {
  const records = new Map(), queries = [], notifications = [];
  const snapshot = ref => ({ id: ref.id, ref, exists: records.has(ref.path), data: () => records.get(ref.path) });
  function doc(documentPath) {
    return { path:documentPath, id:documentPath.split('/').at(-1), get:async function () { return snapshot(this); }, collection:name => collection(`${documentPath}/${name}`) };
  }
  function collection(collectionPath, filters = [], ordering = [], maximum = null, after = null) {
    const query = {
      doc:id => doc(`${collectionPath}/${id}`),
      where:(field, operator, value) => collection(collectionPath, [...filters, { field, operator, value }], ordering, maximum, after),
      orderBy:(field, direction = 'asc') => collection(collectionPath, filters, [...ordering, { field, direction }], maximum, after),
      limit:value => collection(collectionPath, filters, ordering, value, after),
      startAfter:(...values) => collection(collectionPath, filters, ordering, maximum, values),
      count:() => ({ get:async () => { const result = await query.get(true); return { data:() => ({ count:result.size }) }; } }),
      get:async (aggregate = false) => {
        if (!aggregate) { assert(maximum !== null, 'List queries must be bounded'); queries.push({ collectionPath, maximum, filters, ordering, after }); }
        const getField = (record, field) => field === '__name__' ? record.id : record.data()[field];
        const compare = (a, b) => {
          for (const { field, direction } of ordering) {
            const first = valueOf(getField(a, field)), second = valueOf(getField(b, field));
            if (first !== second) return (first < second ? -1 : 1) * (direction === 'desc' ? -1 : 1);
          }
          return 0;
        };
        let docs = [...records.keys()].filter(key => key.startsWith(`${collectionPath}/`) && key.split('/').length === collectionPath.split('/').length + 1).map(key => snapshot(doc(key)));
        docs = docs.filter(record => filters.every(({ field, operator, value }) => {
          const actual = record.data()[field];
          return operator === '==' ? actual === value : operator === '>=' ? actual >= value : actual <= value;
        }));
        docs.sort(compare);
        if (after) {
          const boundary = { id:after[ordering.findIndex(item => item.field === '__name__')], data:() => Object.fromEntries(ordering.map(({field}, index) => [field, after[index]])) };
          docs = docs.filter(record => compare(record, boundary) > 0);
        }
        if (maximum !== null) docs = docs.slice(0, maximum);
        return { docs, size:docs.length };
      },
    };
    return query;
  }
  const db = { collection, runTransaction:async callback => {
    const changes = [];
    const transaction = {
      get:async ref => { assert.equal(changes.length, 0, 'All transaction reads must precede writes'); return snapshot(ref); },
      set:(ref, data, options) => changes.push(() => records.set(ref.path, { ...(options?.merge ? records.get(ref.path) : {}), ...data })),
      update:(ref, data) => changes.push(() => records.set(ref.path, { ...records.get(ref.path), ...data })),
      delete:ref => changes.push(() => records.delete(ref.path)),
    };
    const result = await callback(transaction);
    changes.forEach(commit => commit());
    return result;
  } };
  for (const id of ['alice', 'bob', 'carol']) records.set(`playerProfiles/${id}`, { username:id, usernameLower:id, bio:`${id} bio`, birthDate:'1990-01-01', email:`${id}@example.test`, avatarKey:'private-key', emailSearchHash:'private-hash', createdAt:new Timestamp(1700000000) });
  const modules = new Map();
  function load(filename) {
    const resolved = path.resolve(root, filename);
    if (modules.has(resolved)) return modules.get(resolved).exports;
    const compiledModule = { exports:{} };
    modules.set(resolved, compiledModule);
    const code = ts.transpileModule(readFileSync(resolved, 'utf8'), { compilerOptions:{ module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022 } }).outputText;
    function mockedRequire(specifier) {
      if (specifier === 'next/server') return { NextResponse };
      if (specifier === 'firebase-admin/firestore') return { Timestamp, FieldPath:{ documentId:() => '__name__' }, FieldValue:{ serverTimestamp:() => new Timestamp(1700000001) } };
      if (specifier.endsWith('/firebase-admin')) return { adminDb:db };
      if (specifier.endsWith('/dev-content-db')) return { isDevVideoWriter: () => false, isDevSocialWriter: () => false, isDevProfileWriter: () => false };
      if (specifier.endsWith('/dev-videos')) return {};
      if (specifier.endsWith('/dev-social')) return {};
      if (specifier.endsWith('/dev-profiles')) return {};
      if (specifier.endsWith('/player-auth')) return { requirePlayer:async request => {
        const id = request.headers.get('authorization')?.replace('Bearer ', '');
        if (!['alice', 'bob', 'carol'].includes(id)) throw new Error('UNAUTHORIZED');
        return { id, email:`${id}@example.test`, emailVerified:true };
      } };
      if (specifier.endsWith('/profile-avatars')) return { profileAvatarUrl:async () => 'https://fixture.invalid/avatar' };
      if (specifier.endsWith('/s3-videos')) return { signedVideoUrl:async () => 'https://fixture.invalid/thumbnail' };
      if (specifier.endsWith('/player-profiles')) return { playerDisplayProfiles:async ids => new Map(ids.map(id => [id, { username:records.get(`playerProfiles/${id}`).username, avatarUrl:null }])) };
      if (specifier.endsWith('/friend-push')) return { notifyFriendRequest:async (...args) => notifications.push(args) };
      if (specifier.startsWith('.')) return load(`${path.resolve(path.dirname(resolved), specifier)}.ts`);
      if (specifier.startsWith('node:')) return require(specifier);
      throw new Error(`Unmocked dependency: ${specifier}`);
    }
    vm.runInNewContext(`(function(require, module, exports) { ${code}\n})`, { Response, Request, URL, Buffer, console, Date, Error })(mockedRequire, compiledModule, compiledModule.exports);
    return compiledModule.exports;
  }
  const request = (viewer, route, body) => new Request(`https://fixture.invalid/api/public${route}`, { headers:{ authorization:`Bearer ${viewer}`, 'content-type':'application/json' }, ...(body ? { method:'POST', body:JSON.stringify(body) } : {}) });
  const follow = (viewer, target, action) => load('app/api/public/creators/[id]/follow/route.ts').POST(request(viewer, `/creators/${target}/follow`, { action }), { params:Promise.resolve({id:target}) });
  const friendship = (viewer, target, action) => load('app/api/public/friends/route.ts').POST(request(viewer, '/friends', { targetId:target, action }));
  const profile = (viewer, id) => load('lib/creator-profile.ts').creatorProfile(db, id, viewer);
  const list = (viewer, id, cursor) => load('app/api/public/creators/[id]/clips/route.ts').GET(request(viewer, `/creators/${id}/clips${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`), { params:Promise.resolve({id}) });
  const search = (viewer, q, cursor) => load('app/api/public/creators/search/route.ts').GET(request(viewer, `/creators/search?q=${encodeURIComponent(q)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
  return { records, notifications, queries, load, request, follow, friendship, profile, list, search };
}

test('following writes reciprocal documents once; declining retains the follower', async () => {
  const f = fixture();
  const first = await (await f.follow('alice', 'bob', 'follow')).json();
  assert.equal(first.following, true);
  assert.equal(first.followerCount, 1);
  assert.equal(first.friendCount, 0);
  assert.equal(f.records.get('playerProfiles/alice/friends/bob').state, 'outgoing');
  assert.equal(f.records.get('playerProfiles/bob/friends/alice').state, 'incoming');
  assert(f.records.has('playerProfiles/bob/followers/alice'));
  assert.equal((await f.follow('alice', 'bob', 'follow')).status, 200);
  assert.equal(f.notifications.length, 1);
  assert.equal((await f.friendship('bob', 'alice', 'remove')).status, 200);
  const retained = await f.profile('alice', 'bob');
  assert.equal(retained.followerCount, 1);
  assert.equal(retained.following, true);
  assert.equal(retained.friendState, null);
  await f.follow('alice', 'bob', 'follow');
  assert.equal(f.notifications.length, 1);
  assert(!f.records.has('playerProfiles/alice/friends/bob'));
});

test('only recipients accept; accepted friends survive unfollow and followers survive unfriend', async () => {
  const f = fixture();
  await f.follow('alice', 'bob', 'follow');
  assert.equal((await f.follow('alice', 'bob', 'accept')).status, 409);
  const accepted = await (await f.follow('bob', 'alice', 'accept')).json();
  assert.equal(accepted.friendState, 'accepted');
  assert.equal(accepted.followerCount, 1);
  assert.equal(accepted.friendCount, 1);
  assert.equal((await f.profile('alice', 'bob')).friendCount, 1);
  await f.follow('bob', 'alice', 'unfollow');
  assert.equal((await f.profile('alice', 'bob')).friendCount, 1);
  await f.friendship('alice', 'bob', 'remove');
  const result = await f.profile('alice', 'bob');
  assert.equal(result.friendCount, 0);
  assert.equal(result.followerCount, 1);
  assert.equal(result.following, true);
});

test('unfollow cancels outgoing requests; self, missing, and unauthenticated writes make no records', async () => {
  const f = fixture();
  for (const [viewer, target, status] of [['alice','alice',400], ['alice','missing',409], ['unknown','bob',401]]) {
    assert.equal((await f.follow(viewer, target, 'follow')).status, status);
    assert.equal(f.records.size, 3);
  }
  await f.follow('alice', 'bob', 'follow');
  await f.follow('alice', 'bob', 'unfollow');
  assert.equal(f.records.size, 3);
});

test('creator profiles exclude private fields and count only accepted friends and public uploads', async () => {
  const f = fixture();
  f.records.set('videos/published', { uploaderId:'bob', status:'Published' });
  f.records.set('videos/draft', { uploaderId:'bob', status:'Draft' });
  await f.follow('alice', 'bob', 'follow');
  const publicProfile = await f.profile('alice', 'bob');
  assert.equal(publicProfile.clipCount, 1);
  assert.equal(publicProfile.friendCount, 0);
  assert.equal((await f.profile('bob', 'bob')).clipCount, 2);
  for (const key of ['email', 'emailSearchHash', 'birthDate', 'avatarKey']) assert(!(key in publicProfile));
});

test('profile edits save a bounded bio, preserve it for older clients, and keep the search hash private', async () => {
  const f = fixture();
  const route = f.load('app/api/public/profile/route.ts');
  const saved = await route.PUT(f.request('alice', '/profile', { username:'Alice', birthDate:null, bio:' A new bio. ' }));
  assert.equal(saved.status, 200);
  const data = await saved.json();
  assert.equal(data.bio, 'A new bio.');
  assert(!('emailSearchHash' in data));
  assert.equal(f.records.get('playerProfiles/alice').emailSearchHash, f.load('lib/creator-search.ts').emailSearchKey('alice@example.test'));
  await route.PUT(f.request('alice', '/profile', { username:'Alice', birthDate:null }));
  assert.equal(f.records.get('playerProfiles/alice').bio, 'A new bio.');
  const invalid = await route.PUT(f.request('alice', '/profile', { username:'Alice', birthDate:null, bio:'x'.repeat(281) }));
  assert.equal(invalid.status, 400);
  assert.equal(f.records.get('playerProfiles/alice').bio, 'A new bio.');
});

test('upload cursors preserve timestamp ties, bound batches, hide drafts, and reject scope changes', async () => {
  const f = fixture();
  for (let i = 0; i < 27; i++) f.records.set(`videos/clip-${String(i).padStart(2,'0')}`, { uploaderId:'bob', status:i === 0 ? 'Draft' : 'Published', videoKey:'private-video', thumbnailKey:'private-thumbnail', title:`Clip ${i}`, createdAt:new Timestamp(1700000000, 5) });
  const first = await (await f.list('alice', 'bob')).json();
  assert.equal(first.clips.length, 12);
  assert(!first.clips.some(clip => clip.status === 'Draft'));
  assert(!first.clips.some(clip => 'videoKey' in clip || 'thumbnailKey' in clip));
  const second = await (await f.list('alice', 'bob', first.nextCursor)).json();
  const third = await (await f.list('alice', 'bob', second.nextCursor)).json();
  assert.equal(new Set([...first.clips, ...second.clips, ...third.clips].map(clip => clip.id)).size, 26);
  assert.equal(third.nextCursor, null);
  assert.equal((await f.list('bob', 'bob', first.nextCursor)).status, 400);
  assert.equal((await f.list('alice', 'carol', first.nextCursor)).status, 400);
  const own = await (await f.list('bob', 'bob')).json();
  assert(own.nextCursor);
  assert(f.queries.filter(query => query.collectionPath === 'videos').every(query => query.maximum === 13));
});

test('username/email search uses bounded query cursors and returns only display profiles', async () => {
  const f = fixture();
  const { emailSearchKey } = f.load('lib/creator-search.ts');
  for (let i = 0; i < 22; i++) f.records.set(`playerProfiles/many-${i}`, { username:`Many${i}`, usernameLower:`many${i}`, email:'private@example.test' });
  f.records.get('playerProfiles/bob').emailSearchHash = emailSearchKey('BOB@example.test');
  const first = await (await f.search('alice', 'many')).json();
  const second = await (await f.search('alice', 'many', first.nextCursor)).json();
  assert.equal(first.players.length, 15);
  assert.equal(new Set([...first.players, ...second.players].map(player => player.id)).size, 22);
  assert.equal(second.nextCursor, null);
  assert.equal((await f.search('alice', 'bob', first.nextCursor)).status, 400);
  const exact = await (await f.search('alice', 'BOB@example.test')).json();
  assert.equal(exact.players[0].id, 'bob');
  assert.deepEqual(Object.keys(exact.players[0]).sort(), ['avatarUrl','id','username']);
  assert.equal((await (await f.search('alice', 'bob@')).json()).players.length, 0);
  assert(f.queries.filter(query => query.collectionPath === 'playerProfiles').every(query => query.maximum === 16));
});
