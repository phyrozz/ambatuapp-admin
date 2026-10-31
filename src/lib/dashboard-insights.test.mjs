import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../app/api/dashboard/insights/route.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
function setup({ root = true, postgres = true, failCommunity = false } = {}) {
  const queries = [];
  const db = { query: async (sql, args) => {
    queries.push({ sql, args });
    if (sql.includes('FROM app.content WHERE kind=')) return { rows: [{ status: 'Published', created_at: '2026-10-30', n: 2 }, { status: null, created_at: null, n: 1 }] };
    if (sql.includes('FROM app.content c')) return { rows: [{ title: 'Example', votes: 3 }] };
    if (sql.includes('FROM app.comments') || sql.includes('FROM app.follows')) {
      if (failCommunity) throw new Error('offline');
      return { rows: [{ recent: 2, previous: 1 }] };
    }
    if (sql.includes('avatar_moderation')) return { rows: [{ n: 4 }] };
    throw new Error('unexpected query');
  } };
  const flag = () => postgres;
  const withDb = async fn => fn(db);
  const modules = {
    'next/server': { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    'firebase-admin/firestore': { Timestamp: { fromMillis: value => value } },
    '@aws-sdk/client-dynamodb': { DynamoDBClient: class {} },
    '@aws-sdk/lib-dynamodb': { DynamoDBDocumentClient: {}, ScanCommand: class {} },
    '../../../../lib/api-auth': { requireAdmin: async () => ({ roleId: root ? 'root' : 'creator', permissions: {} }) },
    '../../../../lib/studio-api': { studioError: () => ({ status: 500 }) },
    '../../../../lib/firebase-admin': { adminDb: null },
    '../../../../lib/studio-policy.mjs': { canAccess: () => true },
    '../../../../lib/dev-content-db': { isDevCharacterWriter: flag, isDevLoreWriter: flag, isDevVideoWriter: flag, isDevSoundWriter: flag, isDevSocialWriter: flag, isDevProfileWriter: flag, withDevContentDb: withDb, withDevSocialDb: withDb, withDevVideoDb: withDb, withDevProfileDb: withDb },
  };
  const mod = { exports: {} };
  class FixedDate extends Date { static now() { return Date.parse('2026-10-31T04:00:00Z'); } }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Date: FixedDate, process: { env: {} }, require: name => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  } });
  return { route: mod.exports, queries };
}

test('insights respect content ownership restrictions', async () => {
  const { route, queries } = setup({ root: false });
  const result = await route.GET({});
  assert.equal(result.body.restricted, true);
  assert.equal(queries.length, 0);
});

test('insights use completed Philippine days and isolate source failures', async () => {
  const { route, queries } = setup({ failCommunity: true });
  const result = await route.GET({});
  assert.equal(result.status, 200);
  assert.equal(result.body.dates[0], '2026-10-17');
  assert.equal(result.body.dates[13], '2026-10-30');
  assert.equal(result.body.content[0].trend[13], 2);
  assert.equal(result.body.content[0].other, 1);
  assert.equal(result.body.comments, null);
  assert.equal(result.body.follows, null);
  assert.equal(result.body.avatars, 4);
  assert.equal(result.body.reports, null);
  const followQuery = queries.find(entry => entry.sql.includes('FROM app.follows'));
  assert.equal(followQuery.args[2].toISOString(), '2026-10-30T16:00:00.000Z');
});
