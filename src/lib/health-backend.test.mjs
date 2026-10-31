import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../app/api/health/route.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

function setup({ postgres = false, fail = false } = {}) {
  const calls = [];
  const mod = { exports: {} };
  const modules = {
    'next/server': { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    '../../../lib/health-rate-limit': { healthRateLimit: () => null },
    '../../../lib/dev-content-db': {
      isDevContentSnapshot: () => postgres,
      withDevContentDb: async () => { calls.push('postgres'); if (fail) throw new Error('unavailable'); },
    },
    '../../../lib/firebase-admin': {
      adminDb: { collection: () => ({ doc: () => ({ get: async () => { calls.push('firestore'); if (fail) throw new Error('unavailable'); } }) }) },
    },
  };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: name => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  } });
  return { route: mod.exports, calls };
}

test('health checks the selected database and reports failures', async () => {
  for (const postgres of [false, true]) {
    for (const fail of [false, true]) {
      const { route, calls } = setup({ postgres, fail });
      const result = await route.GET();
      assert.deepEqual(calls, [postgres ? 'postgres' : 'firestore']);
      assert.equal(result.status, fail ? 503 : 200);
      assert.equal(result.body.database, fail ? 'unavailable' : 'ok');
      if (!fail) assert.equal(result.body.database_backend, postgres ? 'postgres' : 'firestore');
    }
  }
});
