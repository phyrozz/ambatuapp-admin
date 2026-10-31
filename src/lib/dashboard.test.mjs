import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

async function load(path, dependencies) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => {
    if (name.endsWith('/dev-content-db')) return { isDevProfileWriter: () => false };
    if (name.endsWith('/dev-profiles')) return {};
    const found = Object.entries(dependencies).find(([suffix]) => name.endsWith(suffix));
    if (!found) throw new Error(`Unexpected dependency: ${name}`);
    return found[1];
  } });
  return exports;
}

const next = { NextResponse: { json: (body, options) => ({ body, ...options }) } };

test('dashboard requires view access and counts the correct rolling windows', async () => {
  const filters = [];
  let permission;
  const profiles = {
    count: () => ({ get: async () => ({ data: () => ({ count: 12 }) }) }),
    where: (field, operator, timestamp) => {
      filters.push({ field, operator, timestamp });
      return { count: () => ({ get: async () => ({ data: () => ({ count: filters.length }) }) }) };
    },
  };
  const api = await load('../app/api/dashboard/route.ts', {
    'next/server': next,
    'firebase-admin/firestore': { Timestamp: { fromMillis: value => value } },
    '/api-auth': { requireAdmin: async (_request, needed) => { permission = needed; } },
    '/studio-access': { studioDb: () => ({ collection: name => { assert.equal(name, 'playerProfiles'); return profiles; } }) },
    '/studio-api': { studioError: error => { throw error; } },
  });
  const before = Date.now();
  const result = await api.GET({});
  assert.equal(permission.module, 'dashboard');
  assert.equal(permission.action, 'view');
  assert.equal(result.body.registered, 12);
  assert.equal(result.body.activeMonth, 4);
  assert.deepEqual(filters.map(item => item.field), ['createdAt', 'lastActiveAt', 'lastActiveAt', 'lastActiveAt']);
  for (const [index, days] of [7, 1, 7, 30].entries()) {
    assert.ok(Math.abs(filters[index].timestamp - (before - days * 86400000)) < 1000);
  }
});

test('activity records only existing authenticated profiles and limits writes', async () => {
  let exists = true;
  let lastActive = null;
  let updates = 0;
  let signedIn = true;
  const db = {
    collection: name => { assert.equal(name, 'playerProfiles'); return { doc: id => { assert.equal(id, 'player-1'); return {}; } }; },
    runTransaction: async action => action({
      get: async () => ({ exists, data: () => ({ lastActiveAt: lastActive === null ? null : { toMillis: () => lastActive } }) }),
      update: () => { updates++; },
    }),
  };
  const api = await load('../app/api/public/profile/activity/route.ts', {
    'next/server': next,
    'firebase-admin/firestore': { FieldValue: { serverTimestamp: () => 'server-time' } },
    '/firebase-admin': { adminDb: db },
    '/player-auth': { requirePlayer: async () => { if (!signedIn) throw new Error('unauthorized'); return { id: 'player-1' }; } },
  });
  assert.equal((await api.POST({})).body.ok, true);
  assert.equal(updates, 1);
  lastActive = Date.now();
  await api.POST({});
  assert.equal(updates, 1);
  lastActive -= 16 * 60000;
  await api.POST({});
  assert.equal(updates, 2);
  exists = false;
  await api.POST({});
  assert.equal(updates, 2);
  signedIn = false;
  assert.equal((await api.POST({})).status, 401);
  assert.equal(updates, 2);
});
