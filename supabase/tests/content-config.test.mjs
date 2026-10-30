import test from 'node:test';
import assert from 'node:assert/strict';
import { isDevCharacterWriter, isDevContentSnapshot, isDevLoreWriter, isDevSoundWriter } from '../../src/lib/dev-content-db.ts';

test('the snapshot backend is opt-in and restricted to the Firebase dev project and Next development mode', () => {
  const previous = { ...process.env };
  try {
    delete process.env.CONTENT_READ_BACKEND;
    delete process.env.CHARACTER_WRITE_BACKEND;
    delete process.env.LORE_WRITE_BACKEND;
    delete process.env.SOUND_WRITE_BACKEND;
    assert.equal(isDevContentSnapshot(), false);
    assert.equal(isDevCharacterWriter(), false);
    assert.equal(isDevLoreWriter(), false);
    assert.equal(isDevSoundWriter(), false);
    process.env.CHARACTER_WRITE_BACKEND = 'postgres-dev';
    process.env.LORE_WRITE_BACKEND = 'postgres-dev';
    process.env.SOUND_WRITE_BACKEND = 'postgres-dev';
    assert.throws(isDevCharacterWriter);
    assert.throws(isDevLoreWriter);
    assert.throws(isDevSoundWriter);
    process.env.CONTENT_READ_BACKEND = 'postgres-dev-snapshot';
    process.env.NODE_ENV = 'development';
    process.env.FIREBASE_PROJECT_ID = 'ambatuapp-dev';
    assert.equal(isDevContentSnapshot(), true);
    assert.equal(isDevCharacterWriter(), true);
    assert.equal(isDevLoreWriter(), true);
    assert.equal(isDevSoundWriter(), true);
    process.env.FIREBASE_PROJECT_ID = 'ambatuapp-bcebb';
    assert.throws(isDevContentSnapshot);
    process.env.FIREBASE_PROJECT_ID = 'ambatuapp-dev';
    process.env.NODE_ENV = 'production';
    assert.throws(isDevContentSnapshot);
    assert.throws(isDevCharacterWriter);
    assert.throws(isDevLoreWriter);
    assert.throws(isDevSoundWriter);
    process.env.CONTENT_READ_BACKEND = 'unexpected';
    assert.throws(isDevContentSnapshot);
  } finally {
    for (const key of ['CONTENT_READ_BACKEND', 'CHARACTER_WRITE_BACKEND', 'LORE_WRITE_BACKEND', 'SOUND_WRITE_BACKEND', 'NODE_ENV', 'FIREBASE_PROJECT_ID']) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
