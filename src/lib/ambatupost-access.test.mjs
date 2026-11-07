import test from 'node:test';
import assert from 'node:assert/strict';
import { canReadDream, canInteractWithDream } from './ambatupost-access.ts';

const published = { authorId: 'author', audience: 'public', publication: 'published', moderation: 'visible', authorDeleting: false };
const unrelated = { blocked: false, acceptedByViewer: false, acceptedByAuthor: false };
test('Dream policy covers audiences, pending/reciprocal friendship, owner and guest', () => {
  assert.equal(canReadDream(null, published, unrelated), true);
  assert.equal(canInteractWithDream(null, published, unrelated), false);
  for (const audience of ['public', 'friends', 'only_me']) {
    const dream = { ...published, audience };
    assert.equal(canReadDream('author', dream, unrelated), true);
    assert.equal(canInteractWithDream('author', dream, unrelated), true);
    assert.equal(canReadDream('stranger', dream, unrelated), audience === 'public');
    assert.equal(canReadDream(null, dream, unrelated), audience === 'public');
    assert.equal(canReadDream('friend', dream, { ...unrelated, acceptedByViewer: true }), audience === 'public');
    assert.equal(canReadDream('friend', dream, { ...unrelated, acceptedByViewer: true, acceptedByAuthor: true }), audience !== 'only_me');
    assert.equal(canReadDream('blocked', dream, { ...unrelated, blocked: true, acceptedByViewer: true, acceptedByAuthor: true }), false);
  }
});
test('drafts, removed posts and deleting authors cannot leak to other viewers or votes', () => {
  for (const change of [{ publication: 'draft' }, { publication: 'processing' }, { publication: 'failed' }, { moderation: 'removed' }, { authorDeleting: true }]) {
    const dream = { ...published, ...change };
    assert.equal(canReadDream('stranger', dream, unrelated), false);
    assert.equal(canReadDream(null, dream, unrelated), false);
    assert.equal(canInteractWithDream('author', dream, unrelated), false);
  }
  assert.equal(canReadDream('author', { ...published, publication: 'draft' }, unrelated), true);
  assert.equal(canReadDream('author', { ...published, authorDeleting: true }, unrelated), false);
});
