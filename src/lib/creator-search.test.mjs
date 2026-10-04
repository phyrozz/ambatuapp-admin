import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCreatorQuery, creatorSearchMode, emailSearchKey } from './creator-search.ts';

test('email searches require a complete address and never become prefix searches', () => {
  for (const query of ['a@', 'a@domain', 'a b@domain.test', 'a@b@domain.test']) assert.equal(creatorSearchMode(query), null);
  assert.equal(creatorSearchMode('player@domain.test'), 'email');
  assert.equal(creatorSearchMode('player'), 'username');
  assert.equal(creatorSearchMode('x'), null);
  assert.equal(creatorSearchMode('x'.repeat(25)), null);
});

test('case and surrounding whitespace match the same verified email index', () => {
  assert.equal(emailSearchKey(' Player@Example.TEST '), emailSearchKey('player@example.test'));
  assert.notEqual(emailSearchKey('one@example.test'), emailSearchKey('two@example.test'));
  assert(!emailSearchKey('player@example.test').includes('@'));
  assert.equal(normalizeCreatorQuery(' Ｄｒｅａｍｅｒ '), 'dreamer');
});
