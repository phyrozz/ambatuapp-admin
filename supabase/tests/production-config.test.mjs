import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/lib/dev-content-db.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function setup(changes = {}) {
  const env = { NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'ambatuapp-bcebb', CONTENT_READ_BACKEND: 'postgres-prod', PRODUCTION_POSTGRES_CUTOVER: 'enabled',
    PROD_SUPABASE_PROJECT_REF: 'testref', PROD_CONTENT_PG_HOST: 'aws-0-ap-southeast-1.pooler.supabase.com',
    PROD_CONTENT_PG_USER: 'ambatu_prod_content_reader.testref', PROD_CONTENT_PG_PASSWORD: 'test-only', PROD_CONTENT_PG_CA_FILE: 'test-ca', ...changes };
  const queries = [], configs = [];
  class Pool {
    constructor(config) { configs.push(config); }
    on() {}
    async connect() { return { query: async (sql, params) => { queries.push({ sql, params }); return { rowCount: 1, rows: [] }; }, release() {} }; }
  }
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, process: { env }, console,
    require: name => name === 'pg' ? { Pool } : name === 'node:fs' ? { readFileSync: () => 'test-ca' } : (() => { throw Error(name); })() });
  return { api: mod.exports, env, queries, configs };
}
test('production is explicit and cannot mix Firestore and Postgres backends', () => {
  for (const change of [{ NODE_ENV: 'development' }, { FIREBASE_PROJECT_ID: 'ambatuapp-dev' }, { PRODUCTION_POSTGRES_CUTOVER: '' }, { LORE_WRITE_BACKEND: 'firestore' }, { VIDEO_WRITE_BACKEND: 'postgres-dev' }]) {
    assert.throws(() => setup(change).api.isDevContentSnapshot(), /Invalid production database configuration/);
  }
  const { api } = setup();
  for (const name of ['isDevContentSnapshot', 'isDevCharacterWriter', 'isDevLoreWriter', 'isDevSoundWriter', 'isDevVideoWriter',
    'isDevSocialWriter', 'isDevProfileWriter', 'isDevLeaderboardWriter', 'isDevRateLimitWriter', 'isDevStudioWriter']) assert.equal(api[name](), true);
});
test('production connection requires the correct project, role, TLS certificate, and session port', async () => {
  for (const change of [{ PROD_SUPABASE_PROJECT_REF: 'wrong' }, { PROD_CONTENT_PG_USER: 'postgres.testref' }, { PROD_CONTENT_PG_HOST: 'localhost' },
    { PROD_CONTENT_PG_HOST: 'other.example.com' }, { PROD_CONTENT_PG_CA_FILE: '' }, { PROD_CONTENT_PG_PORT: '6543' }]) {
    const { api, configs } = setup(change);
    await assert.rejects(api.withDevContentDb(async () => {}), /Production database target is not configured/);
    assert.equal(configs.length, 0);
  }
  const { api, queries, configs } = setup();
  await api.withDevVideoDb(async () => 'done');
  assert.equal(configs[0].ssl.rejectUnauthorized, true);
  assert.equal(configs[0].ssl.ca, 'test-ca');
  assert.equal(queries[0].params[0], 'firestore-prod-v1');
  assert.ok(queries.some(query => query.sql === 'SET LOCAL ROLE ambatu_prod_video_writer'));
  assert.ok(queries.some(query => query.sql === 'COMMIT'));
});

test('production supports a certificate supplied through an environment variable', async () => {
  const { api, configs } = setup({ PROD_CONTENT_PG_CA_FILE: '', PROD_CONTENT_PG_CA: 'pem-certificate' });
  await api.withDevContentDb(async () => {});
  assert.equal(configs[0].ssl.ca, 'pem-certificate');
  assert.equal(configs[0].ssl.rejectUnauthorized, true);
});
