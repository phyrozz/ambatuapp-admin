import assert from 'node:assert/strict';
import test from 'node:test';
import { followTransition, reciprocalFriendState } from './follow-state.ts';

test('a new follower sends one request and retries cannot duplicate it', () => {
  const next = followTransition(false, null, 'follow');
  assert.equal(next.following, true);
  assert.equal(next.state, 'outgoing');
  assert.equal(reciprocalFriendState(next.state), 'incoming');
  assert.equal(next.notify, true);
  const retry = followTransition(true, 'outgoing', 'follow');
  assert.equal(retry.state, 'outgoing');
  assert.equal(retry.writeFriendship, false);
  assert.equal(retry.notify, false);
});

test('a declined request leaves its follower and a retried follow does not recreate it', () => {
  const next = followTransition(true, null, 'follow');
  assert.equal(next.following, true);
  assert.equal(next.state, null);
  assert.equal(next.writeFriendship, false);
  assert.equal(next.notify, false);
});

test('accepting follows back and makes both users friends; following alone cannot accept', () => {
  const next = followTransition(false, 'incoming', 'accept');
  assert.equal(next.following, true);
  assert.equal(next.state, 'accepted');
  assert.equal(reciprocalFriendState(next.state), 'accepted');
  assert.equal(followTransition(false, 'incoming', 'follow').state, 'incoming');
  for (const state of [null, 'outgoing', 'accepted']) assert.throws(() => followTransition(false, state, 'accept'), /INVALID_FRIEND_TRANSITION/);
});

test('unfollowing cancels an outgoing request but retains friends and incoming requests', () => {
  assert.equal(followTransition(true, 'outgoing', 'unfollow').state, null);
  assert.equal(followTransition(true, 'outgoing', 'unfollow').writeFriendship, true);
  for (const state of ['accepted', 'incoming', null]) {
    const next = followTransition(true, state, 'unfollow');
    assert.equal(next.following, false);
    assert.equal(next.state, state);
    assert.equal(next.writeFriendship, false);
  }
});

test('following an existing friend adds only a follow', () => {
  const next = followTransition(false, 'accepted', 'follow');
  assert.equal(next.following, true);
  assert.equal(next.state, 'accepted');
  assert.equal(next.writeFriendship, false);
  assert.equal(next.notify, false);
});
