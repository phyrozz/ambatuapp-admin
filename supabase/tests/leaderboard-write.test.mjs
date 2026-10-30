// Only run against a disposable local PostgreSQL database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';

const require = createRequire(import.meta.url), port = process.env.PGTEST_PORT;
function load(relative, mocks) {
  const file = new URL(relative, import.meta.url), mod = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: name => mocks[name] ?? require(name), Buffer, URL, process, console, Error }, { filename: file.pathname });
  return mod.exports;
}
test('score sync retains the best score under concurrent submissions', { skip: !port }, async () => {
  const admin = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', database: 'postgres' });
  const reader = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'ambatu_dev_content_reader', database: 'postgres' });
  const db = { withDevLeaderboardDb: async callback => {
    const client = await reader.connect();
    try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE ambatu_dev_leaderboard_writer'); const result = await callback(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } };
  const service = load('../../src/lib/dev-leaderboards.ts', { './dev-content-db': db,
    './player-profiles': { playerDisplayProfiles: async ids => new Map(ids.map(id => [id, { username: id, avatarUrl: null }])) } });
  const player = 'leaderboard-test-player', other = 'leaderboard-test-other';
  try {
    await Promise.all([service.submitScore('ambatutap', player, 200), service.submitScore('ambatutap', player, 150),
      service.syncScores(player, { ambatutap: 300, ambatusnake: 30 }), service.syncScores(player, { ambatutap: 50, 'flappy-bus': 7 })]);
    const result = await service.syncScores(player, {});
    assert.equal(result.ambatutap, 300); assert.equal(result.ambatusnake, 30); assert.equal(result['flappy-bus'], 7); assert.equal(result.ambatublou, 0);
    const before = (await admin.query("SELECT updated_at FROM app.leaderboard_entries WHERE game_id='ambatutap' AND player_id=$1", [player])).rows[0].updated_at;
    await service.submitScore('ambatutap', player, 300);
    const after = (await admin.query("SELECT updated_at FROM app.leaderboard_entries WHERE game_id='ambatutap' AND player_id=$1", [player])).rows[0].updated_at;
    assert.equal(before.getTime(), after.getTime());
    await service.submitScore('ambatutap', other, 999999);
    const top = await service.topScores('ambatutap');
    assert.equal(top[0].player, other); assert.equal(top[0].score, 999999);
    const client = await reader.connect();
    try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE ambatu_dev_leaderboard_writer');
      await assert.rejects(client.query('DELETE FROM app.leaderboard_entries'), /permission denied/);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  } finally {
    await admin.query('DELETE FROM app.leaderboard_entries WHERE player_id=ANY($1)', [[player, other]]);
    await reader.end(); await admin.end();
  }
});
