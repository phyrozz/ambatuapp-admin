import assert from 'node:assert/strict';
import test from 'node:test';
import { friendFilter, friendCursor, nextFriendCursor, matchesFriendFilter, validFriendId } from './friend-list.ts';

test('friend cursors cannot be reused across request states or private pin filters', () => {
  const accepted = friendFilter(new URLSearchParams('state=accepted'));
  const pinned = friendFilter(new URLSearchParams('state=accepted&pinned=true'));
  const cursor = nextFriendCursor('player-20', accepted);
  assert.equal(friendCursor(cursor, accepted), 'player-20');
  assert.throws(() => friendCursor(cursor, pinned), /INVALID_CURSOR/);
  assert.throws(() => friendCursor(cursor, friendFilter(new URLSearchParams())), /INVALID_CURSOR/);
  assert.throws(() => friendCursor(cursor, friendFilter(new URLSearchParams('state=incoming'))), /INVALID_CURSOR/);
  assert.equal(friendCursor('legacy-player', friendFilter(new URLSearchParams())), 'legacy-player');
  assert.throws(() => friendCursor('!invalid', accepted), /INVALID_CURSOR/);
  assert.throws(() => friendCursor('a'.repeat(1025), accepted), /INVALID_CURSOR/);
});

test('pins only show accepted friends and invalid request filters are rejected', () => {
  const filter = friendFilter(new URLSearchParams('pinned=true'));
  assert(matchesFriendFilter({ state: 'accepted', pinned: true }, filter));
  assert(!matchesFriendFilter({ state: 'incoming', pinned: true }, filter));
  assert(!matchesFriendFilter({ state: 'accepted' }, filter));
  for (const query of ['state=unknown', 'state=incoming&pinned=true', 'pinned=false']) assert.throws(() => friendFilter(new URLSearchParams(query)), /INVALID_FILTER/);
  assert(!validFriendId('../other-user'));
  assert(!validFriendId('user/name'));
  assert(validFriendId('user-123_456'));
});
