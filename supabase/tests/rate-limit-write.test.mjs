// Only run against a disposable local PostgreSQL database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';

const require = createRequire(import.meta.url), port = process.env.PGTEST_PORT;
function load(relative, mocks) {
  const file = new URL(relative, import.meta.url), mod = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: name => mocks[name] ?? require(name), Buffer, URL, process, console, Error, Date }, { filename: file.pathname });
  return mod.exports;
}
test('rate limits reject excess concurrent writes and preserve independent windows', { skip: !port }, async () => {
  const admin = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', database: 'postgres' });
  const reader = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'ambatu_dev_content_reader', database: 'postgres' });
  const db = { isDevRateLimitWriter: () => true, withDevRateLimitDb: async callback => {
    const client = await reader.connect();
    try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE ambatu_dev_rate_limit_writer'); const result = await callback(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } };
  const service = load('../../src/lib/public-write-limits.ts', { './dev-content-db': db, 'firebase-admin/firestore': {} });
  const player = 'rate-limit-test-player', hash = createHash('sha256').update(player).digest('hex');
  try {
    const limits = [{ key: 'minute', max: 3, windowMs: 60_000 }, { key: 'day', max: 5, windowMs: 86_400_000 }];
    const results = await Promise.all(Array.from({ length: 10 }, () => service.allowPlayerWrite(null, player, 'test', limits)));
    assert.equal(results.filter(Boolean).length, 3);
    let rates = (await admin.query('SELECT rates FROM app.public_api_rate_limits WHERE player_hash=$1', [hash])).rows[0].rates;
    assert.equal(rates['test.minute'].count, 3); assert.equal(rates['test.day'].count, 3);
    assert.equal(await service.allowPlayerWrite(null, player, 'another', [{ key: 'minute', max: 1, windowMs: 60_000 }]), true);
    rates['test.minute'].startedAt = Date.now() - 120_000;
    await admin.query('UPDATE app.public_api_rate_limits SET rates=$2 WHERE player_hash=$1', [hash, rates]);
    assert.equal(await service.allowPlayerWrite(null, player, 'test', limits), true);
    assert.equal(await service.allowPlayerWrite(null, player, 'test', limits), true);
    assert.equal(await service.allowPlayerWrite(null, player, 'test', limits), false);
    rates = (await admin.query('SELECT rates FROM app.public_api_rate_limits WHERE player_hash=$1', [hash])).rows[0].rates;
    assert.equal(rates['test.day'].count, 5); assert.equal(rates['test.minute'].count, 2);
    const client = await reader.connect();
    try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE ambatu_dev_rate_limit_writer');
      await assert.rejects(client.query('SELECT * FROM app.player_profiles'), /permission denied/); await client.query('ROLLBACK');
    } finally { client.release(); }
  } finally {
    await admin.query('DELETE FROM app.public_api_rate_limits WHERE player_hash=$1', [hash]);
    await reader.end(); await admin.end();
  }
});
