// Only run against a disposable local PostgreSQL database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';
import * as policy from '../../src/lib/studio-policy.mjs';

const require = createRequire(import.meta.url), port = process.env.PGTEST_PORT;
function load(relative, mocks) {
  const file = new URL(relative, import.meta.url), mod = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: name => mocks[name] ?? require(name), Buffer, URL, process, console, Error }, { filename: file.pathname });
  return mod.exports;
}
test('Studio role boundaries, registration, and last root remain protected', { skip: !port }, async () => {
  const admin = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', database: 'postgres' });
  const reader = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'ambatu_dev_content_reader', database: 'postgres' });
  const db = { withDevStudioDb: async callback => {
    const client = await reader.connect();
    try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE ambatu_dev_studio_writer'); const result = await callback(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } };
  const studio = load('../../src/lib/dev-studio.ts', { './dev-content-db': db, './studio-policy.mjs': policy });
  const rootA = 'studio-test-root-a', rootB = 'studio-test-root-b', editor = 'studio-test-editor', pending = 'studio-test-pending';
  const ids = [rootA, rootB, editor, pending]; let roleId;
  const originalRoots = (await admin.query("UPDATE app.studio_users SET enabled=false WHERE role_id='root' AND enabled RETURNING id")).rows.map(row => row.id);
  try {
    await studio.saveUserDb(rootA, { enabled: true, roleId: 'root' }, undefined, true);
    await studio.saveUserDb(rootB, { enabled: true, roleId: 'root' }, undefined, true);
    const role = await studio.saveRoleDb({ name: 'Test editor', permissions: { characters: ['view', 'edit'] } }); roleId = role.id;
    await studio.saveUserDb(editor, { enabled: true, roleId }, { sub: rootA, roleId: 'root' }, true);
    const access = await studio.getAccess(editor);
    assert.equal(policy.canAccess(access.permissions, 'characters', 'edit'), true);
    assert.equal(policy.canAccess(access.permissions, 'users', 'edit'), false);
    assert.equal((await studio.listRecords('studioRoles', null)).items.find(item => item.id === roleId).userCount, 1);
    await assert.rejects(studio.deleteRoleDb(roleId), /roleInUse/);
    await assert.rejects(studio.saveRoleDb({ name: 'Changed', permissions: {} }, 'root'), /rootProtected/);
    await assert.rejects(studio.saveUserDb(editor, { roleId: 'root' }, { sub: 'manager', roleId }), /rootAssignment/);
    await assert.rejects(studio.saveUserDb(rootA, { enabled: false }, { sub: rootA, roleId: 'root' }), /selfChange/);
    const concurrent = await Promise.allSettled([
      studio.saveUserDb(rootA, { enabled: false }, { sub: 'other-root', roleId: 'root' }),
      studio.saveUserDb(rootB, { enabled: false }, { sub: 'other-root', roleId: 'root' }),
    ]);
    assert.equal(concurrent.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter(item => item.status === 'rejected' && /lastRoot/.test(item.reason.message)).length, 1);
    const survivors = (await admin.query("SELECT count(*)::int n FROM app.studio_users WHERE role_id='root' AND enabled")).rows[0].n;
    assert.equal(survivors, 1);
    await studio.saveUserDb(pending, { enabled: true, roleId: null, registrationPending: true }, undefined, true);
    await assert.rejects(studio.getAccess(pending), /forbidden/);
    await assert.rejects(studio.saveUserDb(pending, { roleId }, { sub: rootA, roleId: 'root' }), /registrationPending/);
    const creatorId = await studio.findRole('Creator');
    await studio.completeRegistration(pending, creatorId);
    assert.equal((await studio.getAccess(pending)).roleId, creatorId);
    await studio.saveUserDb(editor, { enabled: false }, { sub: rootA, roleId: 'root' });
    await assert.rejects(studio.getAccess(editor), /forbidden/);
    await studio.deleteRoleDb(roleId);
    const client = await reader.connect();
    try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE ambatu_dev_studio_writer');
      await assert.rejects(client.query('SELECT * FROM app.player_profiles'), /permission denied/); await client.query('ROLLBACK');
    } finally { client.release(); }
  } finally {
    await admin.query('DELETE FROM app.studio_users WHERE id=ANY($1)', [ids]);
    if (roleId) await admin.query('DELETE FROM app.studio_roles WHERE id=$1', [roleId]);
    await admin.query('UPDATE app.studio_users SET enabled=true WHERE id=ANY($1)', [originalRoots]);
    await reader.end(); await admin.end();
  }
});
