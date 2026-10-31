import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as policy from './studio-policy.mjs';
const require = createRequire(import.meta.url);
const source = await readFile(new URL('./studio-access.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function store() {
  const rows = new Map(), writes = [];
  const ref = path => ({ path, id: path.split('/').at(-1), get: async () => snapshot(path) });
  const snapshot = path => ({ id: path.split('/').at(-1), ref: ref(path), exists: rows.has(path), data: () => rows.get(path) });
  const db = {
    collection: name => ({ doc: id => ref(`${name}/${id ?? 'generated'}`) }),
    runTransaction: async callback => {
      const pending = [];
      let mutated = false;
      const tx = {
        get: async reference => { assert.equal(mutated, false, 'Firestore transactions read before writing'); return snapshot(reference.path); },
        set: (reference, value, options) => { mutated = true; pending.push(['set', reference.path, value, options]); },
        update: (reference, value) => { mutated = true; pending.push(['update', reference.path, value]); },
        delete: reference => { mutated = true; pending.push(['delete', reference.path]); },
      };
      const result = await callback(tx);
      for (const [operation, path, value, options] of pending) {
        if (operation === 'delete') rows.delete(path);
        else {
          const prior = operation === 'update' || options?.merge ? rows.get(path) ?? {} : {};
          const merged = { ...prior };
          for (const [key, entry] of Object.entries(value)) merged[key] = entry && typeof entry === 'object' && 'increment' in entry ? (prior[key] ?? 0) + entry.increment : entry;
          rows.set(path, merged);
        }
      }
      writes.push(...pending);
      return result;
    },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => name === './firebase-admin' ? { adminDb: db } : name === './dev-content-db' ? { isDevStudioWriter: () => false } : name === './dev-studio' ? {} : name === './studio-policy.mjs' ? policy : name === 'firebase-admin/firestore' ? { FieldPath: { documentId: () => '__name__' }, FieldValue: { increment: value => ({ increment: value }), serverTimestamp: () => 'timestamp' } } : require(name) });
  return { rows, writes, api: exports };
}
test('Assignments update role counts and assigned roles cannot be deleted', async () => {
  const { rows, api } = store();
  rows.set('studioRoles/editor', { userCount: 0, permissions: { characters: ['view', 'edit'] } });
  await api.saveStudioUser('contributor', { roleId: 'editor', enabled: true }, undefined, true);
  assert.equal(rows.get('studioRoles/editor').userCount, 1);
  await assert.rejects(api.deleteRole('editor'), /studio.errors.roleInUse/);
  await api.saveStudioUser('contributor', { roleId: null }, { sub: 'other', roleId: 'root' });
  assert.equal(rows.get('studioRoles/editor').userCount, 0);
  await api.deleteRole('editor');
  assert.equal(rows.has('studioRoles/editor'), false);
});
test('Root cannot be modified/deleted and only Root may grant or revoke Root', async () => {
  const { rows, writes, api } = store();
  rows.set('studioRoles/root', { userCount: 2, permissions: policy.rootPermissions() });
  rows.set('studioUsers/root-user', { roleId: 'root', enabled: true });
  rows.set('studioUsers/contributor', { roleId: null, enabled: true });
  await assert.rejects(api.saveRole({ name: 'Changed', permissions: {} }, 'root'), /rootProtected/);
  await assert.rejects(api.deleteRole('root'), /rootProtected/);
  await assert.rejects(api.saveStudioUser('contributor', { roleId: 'root' }, { sub: 'manager', roleId: 'manager' }), /rootAssignment/);
  await assert.rejects(api.saveStudioUser('root-user', { enabled: false }, { sub: 'manager', roleId: 'manager' }), /rootAssignment/);
  assert.equal(writes.length, 0);
});
test('No self-demotion, self-removal, or final Root removal', async () => {
  const { rows, writes, api } = store();
  rows.set('studioRoles/root', { userCount: 1, permissions: policy.rootPermissions() });
  rows.set('studioUsers/root-user', { roleId: 'root', enabled: true });
  await assert.rejects(api.saveStudioUser('root-user', { roleId: null }, { sub: 'root-user', roleId: 'root' }), /selfChange/);
  await assert.rejects(api.saveStudioUser('root-user', { enabled: false }, { sub: 'root-user', roleId: 'root' }), /selfChange/);
  await assert.rejects(api.saveStudioUser('root-user', { enabled: false }, { sub: 'other-root', roleId: 'root' }), /lastRoot/);
  assert.equal(writes.length, 0);
});
test('Missing, disabled, unassigned, and missing-role accounts never inherit Root', async () => {
  const { rows, api } = store();
  await assert.rejects(api.getStudioAccess('missing'), /forbidden/);
  rows.set('studioUsers/disabled', { enabled: false, roleId: 'root' });
  await assert.rejects(api.getStudioAccess('disabled'), /forbidden/);
  rows.set('studioUsers/pending', { enabled: true, roleId: null });
  rows.set('studioUsers/orphaned', { enabled: true, roleId: 'removed-role' });
  assert.deepEqual(Object.keys((await api.getStudioAccess('pending')).permissions), []);
  assert.deepEqual(Object.keys((await api.getStudioAccess('orphaned')).permissions), []);
});
