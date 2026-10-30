import test from 'node:test';
import assert from 'node:assert/strict';
import { isDevCharacterWriter, isDevContentSnapshot, isDevLoreWriter, isDevSoundWriter, isDevVideoWriter, isDevSocialWriter, isDevProfileWriter, isDevLeaderboardWriter } from '../../src/lib/dev-content-db.ts';

test('the snapshot backend is opt-in and restricted to the Firebase dev project and Next development mode', () => {
  const previous = { ...process.env };
  try {
    delete process.env.CONTENT_READ_BACKEND;
    delete process.env.CHARACTER_WRITE_BACKEND;
    delete process.env.LORE_WRITE_BACKEND;
    delete process.env.SOUND_WRITE_BACKEND;
    delete process.env.VIDEO_WRITE_BACKEND;
    delete process.env.SOCIAL_WRITE_BACKEND;
    delete process.env.PROFILE_WRITE_BACKEND;
    delete process.env.LEADERBOARD_WRITE_BACKEND;
    assert.equal(isDevContentSnapshot(), false);
    assert.equal(isDevCharacterWriter(), false);
    assert.equal(isDevLoreWriter(), false);
    assert.equal(isDevSoundWriter(), false);
    assert.equal(isDevVideoWriter(), false);
    assert.equal(isDevSocialWriter(), false);
    assert.equal(isDevProfileWriter(), false);
    assert.equal(isDevLeaderboardWriter(), false);
    process.env.CHARACTER_WRITE_BACKEND = 'postgres-dev';
    process.env.LORE_WRITE_BACKEND = 'postgres-dev';
    process.env.SOUND_WRITE_BACKEND = 'postgres-dev';
    process.env.VIDEO_WRITE_BACKEND = 'postgres-dev';
    process.env.SOCIAL_WRITE_BACKEND = 'postgres-dev';
    process.env.PROFILE_WRITE_BACKEND = 'postgres-dev';
    process.env.LEADERBOARD_WRITE_BACKEND = 'postgres-dev';
    assert.throws(isDevCharacterWriter);
    assert.throws(isDevLoreWriter);
    assert.throws(isDevSoundWriter);
    assert.throws(isDevVideoWriter);
    assert.throws(isDevSocialWriter);
    assert.throws(isDevProfileWriter);
    assert.throws(isDevLeaderboardWriter);
    process.env.CONTENT_READ_BACKEND = 'postgres-dev-snapshot';
    process.env.NODE_ENV = 'development';
    process.env.FIREBASE_PROJECT_ID = 'ambatuapp-dev';
    assert.equal(isDevContentSnapshot(), true);
    assert.equal(isDevCharacterWriter(), true);
    assert.equal(isDevLoreWriter(), true);
    assert.equal(isDevSoundWriter(), true);
    assert.equal(isDevVideoWriter(), true);
    assert.equal(isDevSocialWriter(), true);
    assert.equal(isDevProfileWriter(), true);
    assert.equal(isDevLeaderboardWriter(), true);
    delete process.env.SOCIAL_WRITE_BACKEND;
    assert.throws(isDevProfileWriter);
    process.env.SOCIAL_WRITE_BACKEND = 'postgres-dev';
    process.env.FIREBASE_PROJECT_ID = 'ambatuapp-bcebb';
    assert.throws(isDevContentSnapshot);
    process.env.FIREBASE_PROJECT_ID = 'ambatuapp-dev';
    process.env.NODE_ENV = 'production';
    assert.throws(isDevContentSnapshot);
    assert.throws(isDevCharacterWriter);
    assert.throws(isDevLoreWriter);
    assert.throws(isDevSoundWriter);
    assert.throws(isDevVideoWriter);
    assert.throws(isDevSocialWriter);
    assert.throws(isDevProfileWriter);
    assert.throws(isDevLeaderboardWriter);
    process.env.CONTENT_READ_BACKEND = 'unexpected';
    assert.throws(isDevContentSnapshot);
  } finally {
    for (const key of ['CONTENT_READ_BACKEND', 'CHARACTER_WRITE_BACKEND', 'LORE_WRITE_BACKEND', 'SOUND_WRITE_BACKEND', 'VIDEO_WRITE_BACKEND', 'SOCIAL_WRITE_BACKEND', 'PROFILE_WRITE_BACKEND', 'LEADERBOARD_WRITE_BACKEND', 'NODE_ENV', 'FIREBASE_PROJECT_ID']) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
