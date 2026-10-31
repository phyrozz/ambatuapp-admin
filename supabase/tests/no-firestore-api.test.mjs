import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const id = '11111111-1111-4111-8111-111111111111';
function load(relative, overrides = {}) {
  const file = new URL(relative, import.meta.url), mod = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const dependencies = {
    'next/server': { NextResponse: class extends Response { static json = Response.json; static redirect = (url, init) => new Response(null, { ...init, headers: { ...init?.headers, location: url } }); } },
    'firebase-admin/firestore': { FieldValue: {}, FieldPath: {}, Timestamp: class {} },
    'firebase-admin': { adminDb: null },
    'dev-content-db': { isDevContentSnapshot: () => true, isDevCharacterWriter: () => true, isDevLoreWriter: () => true, isDevSoundWriter: () => true,
      isDevVideoWriter: () => true, isDevSocialWriter: () => true, isDevProfileWriter: () => true, isDevLeaderboardWriter: () => true, isDevRateLimitWriter: () => true },
    'player-auth': { requirePlayer: async () => ({ id, email: 'test@example.test', emailVerified: true }), playerFromRequest: async () => ({ id, email: 'test@example.test' }) },
    'api-auth': { requireAdmin: async () => ({ sub: id, roleId: 'root' }) },
    'dev-characters': { listStudioCharacters: async () => ({ characters: [{ id }] }), recordCharacterView: async () => true },
    'dev-profiles': { getProfile: async () => ({ username: 'test' }), initializeProfile: async () => ({ username: 'test' }), profileActivity: async () => {}, choosePreset: async () => {}, getProfilePublic: async () => ({ id, username: 'test' }),
      getDisplayProfiles: async ids => new Map(ids.map(value => [value, { username: 'test', avatarUrl: null }])), listPresets: async () => [] },
    'dev-social': { listFriends: async () => ({ rows: [], nextCursor: null }), friendRelationships: async () => new Map(), socialCounts: async () => ({ incoming: 0 }) },
    'dev-sounds': { listStudioSounds: async () => ({ sounds: [] }), publicSoundKey: async () => 'sound-key', recordSoundPlay: async () => 1 },
    'dev-videos': { listStudioVideos: async () => ({ videos: [] }), editPlayerVideo: async () => true, deleteManagedVideo: async () => true, getScrollVideo: async () => ({ id }) },
    'dev-lores': { listStudioLores: async () => ({ lores: [] }), recordLoreView: async () => true },
    'dev-lore-interactions': { listLoreComments: async () => ({ comments: [], nextCursor: null }), createLoreComment: async () => ({ id }), voteLore: async () => ({ value: 1 }) },
    'dev-video-interactions': { listVideoComments: async () => ({ comments: [], nextCursor: null }), createVideoComment: async () => ({ id }), voteVideo: async () => ({ value: 1, upvotes: 1, downvotes: 0 }) },
    'public-write-limits': { allowPlayerWrite: async () => true },
    'player-profiles': { playerDisplayProfiles: async () => new Map(), fallbackPlayerName: () => 'Player' },
    'profile-avatars': { profileAvatarUrl: async () => null },
    'creator-search': { emailSearchKey: () => 'hash' },
    'lore-comment-cursor': { parseLoreCommentCursor: () => null },
    'friend-list': { friendFilter: () => ({ state: null, pinned: false }), friendCursor: () => null, validFriendId: () => true },
    's3-sounds': { signedSoundUrl: async () => 'https://example.test/sound' },
    'studio-api': { adminErrorStatus: () => 400 },
    ...overrides,
  };
  const mockedRequire = name => {
    const key = Object.keys(dependencies).find(item => name === item || name.endsWith(`/${item}`));
    if (key) return dependencies[key];
    if (name.startsWith('node:')) return require(name);
    return {};
  };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: mockedRequire, Buffer, URL, process, console, Request, Response, Error }, { filename: file.pathname });
  return mod.exports;
}
const request = (url, method = 'GET', body) => new Request(`http://test${url}`, { method, headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
test('Supabase routes execute without a Firestore client', async () => {
  const params = { params: Promise.resolve({ id }) };
  const character = load('../../src/app/api/characters/route.ts');
  assert.equal((await character.GET(request('/api/characters'))).status, 200);
  for (const [file, path] of [['lores', '/api/lores'], ['sounds', '/api/sounds'], ['videos', '/api/videos']]) {
    assert.equal((await load(`../../src/app/api/${file}/route.ts`).GET(request(path))).status, 200);
  }
  const profile = load('../../src/app/api/public/profile/route.ts');
  assert.equal((await profile.GET(request('/api/public/profile'))).status, 200);
  const initialize = load('../../src/app/api/public/profile/initialize/route.ts');
  assert.equal((await initialize.POST(request('/api/public/profile/initialize', 'POST'))).status, 200);
  const activity = load('../../src/app/api/public/profile/activity/route.ts');
  assert.equal((await activity.POST(request('/api/public/profile/activity', 'POST'))).status, 200);
  const avatar = load('../../src/app/api/public/profile/avatar/route.ts');
  assert.equal((await avatar.POST(request('/api/public/profile/avatar', 'POST', { avatarId: null }))).status, 200);
  const friends = load('../../src/app/api/public/friends/route.ts');
  assert.equal((await friends.GET(request('/api/public/friends'))).status, 200);
  const audio = load('../../src/app/api/public/sounds/[id]/audio/route.ts');
  assert.equal((await audio.GET(request('/api/public/sounds/clip/audio'), { params: Promise.resolve({ id: 'clip' }) })).status, 302);
  const plays = load('../../src/app/api/public/sounds/[id]/plays/route.ts');
  assert.equal((await plays.POST(request('/api/public/sounds/clip/plays', 'POST', {}), { params: Promise.resolve({ id: 'clip' }) })).status, 200);
  const video = load('../../src/app/api/public/videos/[id]/route.ts');
  assert.equal((await video.PATCH(request('/api/public/videos/id', 'PATCH', { title: 'Title', description: '' }), params)).status, 200);
  assert.equal((await video.DELETE(request('/api/public/videos/id', 'DELETE'), params)).status, 200);
  const videoComments = load('../../src/app/api/public/videos/[id]/comments/route.ts');
  assert.equal((await videoComments.GET(request('/api/public/videos/id/comments'), params)).status, 200);
  assert.equal((await videoComments.POST(request('/api/public/videos/id/comments', 'POST', { text: 'test' }), params)).status, 201);
  const videoVote = load('../../src/app/api/public/videos/[id]/vote/route.ts');
  assert.equal((await videoVote.POST(request('/api/public/videos/id/vote', 'POST', { value: 1 }), params)).status, 200);
  const loreComments = load('../../src/app/api/public/lores/[id]/comments/route.ts');
  assert.equal((await loreComments.GET(request('/api/public/lores/id/comments'), params)).status, 200);
  assert.equal((await loreComments.POST(request('/api/public/lores/id/comments', 'POST', { text: 'test' }), params)).status, 201);
  const scroll = load('../../src/app/api/public/scroll/[id]/route.ts');
  assert.equal((await scroll.GET(request('/api/public/scroll/id'), params)).status, 200);
});

test('shared contribution and creator helpers do not need Firestore in Supabase mode', async () => {
  const helper = load('../../src/lib/community-content.ts');
  assert.equal((await helper.contributionPlayer(request('/api/public/contributions'))).id, id);
  await helper.limitContribution(id, 'test', 10);
  assert.throws(() => helper.requireContributionFirestore(), error => error.status === 503);
  const creator = load('../../src/lib/creator-profile.ts', {
    'dev-profiles': { getProfilePublic: async () => ({ id, username: 'test', bio: '', avatarUrl: null, joinedAt: null }) },
    'dev-social': { socialCounts: async () => ({ followers: 1, friends: 2, following: true, state: 'accepted' }) },
    'dev-videos': { creatorClipCount: async () => 3 },
  });
  const profile = await creator.creatorProfile(null, id, 'other-player');
  assert.equal(profile.friendCount, 2);
  assert.equal(profile.clipCount, 3);
  assert.equal(profile.following, true);
});
