import assert from 'node:assert/strict';
import test from 'node:test';
import { friendTransition } from './friend-state.ts';

test('requests create reciprocal pending states and retries stay pending', () => {
  assert.deepEqual(friendTransition(undefined, 'request'), ['outgoing', 'incoming']);
  assert.deepEqual(friendTransition('outgoing', 'request'), ['outgoing', 'incoming']);
});
test('only a recipient can accept a request', () => {
  assert.deepEqual(friendTransition('incoming', 'accept'), ['accepted', 'accepted']);
  for (const state of [undefined, 'outgoing', 'accepted']) assert.throws(() => friendTransition(state, 'accept'));
  assert.throws(() => friendTransition('incoming', 'request'));
});
test('requesting an existing friend preserves the relationship', () => {
  assert.deepEqual(friendTransition('accepted', 'request'), ['accepted', 'accepted']);
});
test('either party can cancel, decline, or remove, including an already removed relationship', () => {
  for (const state of [undefined, 'incoming', 'outgoing', 'accepted']) assert.equal(friendTransition(state, 'remove'), null);
});

