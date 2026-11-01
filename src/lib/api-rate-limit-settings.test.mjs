import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(path, mocks, env = {}) {
  const module = { exports: {} };
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: name => mocks[name], process: { env }, Date });
  return module.exports;
}

function fixture() {
  let record;
  const snapshot = () => ({ exists: Boolean(record), data: () => record });
  const ref = { get: async () => snapshot() };
  const db = { collection: () => ({ doc: () => ref }), runTransaction: async callback => callback({
    get: async () => snapshot(), set: (_ref, value) => { record = value; },
  }) };
  const settings = load('./api-rate-limit-settings.ts', { './dev-content-db': { isDevRateLimitWriter: () => false } });
  return { db, settings, getRecord: () => record };
}

test('defaults to enabled and saves changes with optimistic concurrency', async () => {
  const { db, settings, getRecord } = fixture();
  assert.equal((await settings.readApiRateLimitSettings(db)).enabled, true);
  assert.equal((await settings.saveApiRateLimitSettings(db, false, 0, 'admin')).version, 1);
  assert.equal((await settings.readApiRateLimitSettings(db)).enabled, false);
  assert.equal(getRecord().updatedBy, 'admin');
  await assert.rejects(settings.saveApiRateLimitSettings(db, true, 0, 'admin'), /rateLimitSettingsConflict/);
  await assert.rejects(settings.saveApiRateLimitSettings(db, 'false', 1, 'admin'), /rateLimitSettingsInvalid/);
  assert.equal((await settings.saveApiRateLimitSettings(db, true, 1, 'admin')).enabled, true);
});

test('settings API enforces view and edit permissions', async () => {
  const permissions = [];
  const api = load('../app/api/settings/api-rate-limit/route.ts', {
    'next/server': { NextResponse: { json: value => value } },
    '../../../../lib/api-auth': { requireAdmin: async (_request, permission) => { permissions.push(permission); return { sub: 'admin' }; } },
    '../../../../lib/api-rate-limit-settings': { readApiRateLimitSettings: async () => ({}), saveApiRateLimitSettings: async () => ({}) },
    '../../../../lib/firebase-admin': { adminDb: {} },
    '../../../../lib/studio-api': { studioError: error => { throw error; } },
  });
  await api.GET({});
  await api.PUT({ json: async () => ({ enabled: false, version: 0 }) });
  assert.equal(permissions[0].module, 'settings');
  assert.equal(permissions[0].action, 'view');
  assert.equal(permissions[1].action, 'edit');
});

test('Postgres settings persist and reject stale writes', async () => {
  let rates;
  const client = { query: async (sql, args) => {
    if (sql.startsWith('INSERT')) { rates ??= {}; return { rows: [] }; }
    if (sql.startsWith('SELECT')) return { rows: rates ? [{ rates }] : [] };
    if (sql.startsWith('UPDATE')) { rates = JSON.parse(args[1]); return { rows: [] }; }
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const settings = load('./api-rate-limit-settings.ts', { './dev-content-db': {
    isDevRateLimitWriter: () => true, withDevRateLimitDb: callback => callback(client),
  } });
  assert.equal((await settings.readApiRateLimitSettings(null)).enabled, true);
  await settings.saveApiRateLimitSettings(null, false, 0, 'admin');
  assert.equal((await settings.readApiRateLimitSettings(null)).enabled, false);
  await assert.rejects(settings.saveApiRateLimitSettings(null, true, 0, 'admin'), /rateLimitSettingsConflict/);
  assert.equal((await settings.saveApiRateLimitSettings(null, true, 1, 'admin')).enabled, true);
});
