import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as policy from './studio-policy.mjs';
const source = await readFile(new URL('../app/api/studio-registration/route.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function registration({ existing, verified = true, member = true, failMembership = false } = {}) {
  let row = existing, memberships = 0, saves = 0;
  const exports = {};
  const db = { collection: () => ({ doc: () => ({ get: async () => ({ data: () => row }), update: async patch => { row = { ...row, ...patch }; } }) }) };
  vm.runInNewContext(compiled, { exports, require: name => {
    if (name === 'next/server') return { NextResponse: { json: (body, init) => Response.json(body, init) } };
    if (name.endsWith('/api-auth')) return { requireStudioIdentity: async () => ({ sub: 'new-user', username: 'user', email: 'user@example.com', emailVerified: verified }) };
    if (name.endsWith('/cognito-admins')) return { isCurrentAdmin: async () => member, addStudioMembership: async () => { memberships++; if (failMembership) throw new Error('studio.errors.request'); } };
    if (name.endsWith('/studio-access')) return { studioDb: () => db, saveStudioUser: async (_sub, value, _actor, creating) => { assert.equal(creating, true); saves++; row = value; } };
    if (name.endsWith('/studio-api')) return { studioError: error => Response.json({ error: error.message }, { status: 400 }) };
    if (name.endsWith('/studio-policy.mjs')) return policy;
    throw new Error(`Unexpected dependency ${name}`);
  } });
  return { api: exports, row: () => row, memberships: () => memberships, saves: () => saves };
}
const body = { firstName: 'Ada', lastName: 'Contributor', displayName: 'Ada', country: 'Indonesia', bio: '', roleId: 'root', permissions: policy.rootPermissions(), password: 'never-store-this' };
const request = () => new Request('http://studio.test/api/studio-registration', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
test('Registration requires verified email and drops client-supplied roles, permissions and passwords', async () => {
  const unverified = registration({ verified: false });
  assert.equal((await unverified.api.POST(request())).status, 400);
  assert.equal(unverified.saves(), 0); assert.equal(unverified.memberships(), 0);
  const valid = registration();
  assert.equal((await valid.api.POST(request())).status, 200);
  assert.equal(valid.row().roleId, null); assert.equal(valid.row().registrationPending, false);
  assert.equal(valid.row().permissions, undefined); assert.equal(valid.row().password, undefined);
  assert.equal(valid.memberships(), 1);
});
test('Registration cannot restore disabled users or revoked existing Cognito membership', async () => {
  for (const config of [{ existing: { enabled: false, roleId: 'root' } }, { existing: { enabled: true, roleId: 'root' }, member: false }]) {
    const api = registration(config);
    assert.equal((await api.api.POST(request())).status, 400);
    assert.equal(api.saves(), 0); assert.equal(api.memberships(), 0);
  }
});
test('Repeated enrollment preserves existing approved profiles and roles', async () => {
  const existing = { enabled: true, roleId: 'root', displayName: 'Existing approved name' };
  const api = registration({ existing });
  assert.equal((await api.api.POST(request())).status, 200);
  assert.equal(api.row(), existing); assert.equal(api.saves(), 0); assert.equal(api.memberships(), 0);
});
test('Interrupted membership provisioning can retry without granting a role', async () => {
  const failed = registration({ failMembership: true });
  assert.equal((await failed.api.POST(request())).status, 400);
  assert.equal(failed.row().registrationPending, true); assert.equal(failed.row().roleId, null);
  const retry = registration({ existing: failed.row() });
  assert.equal((await retry.api.POST(request())).status, 200);
  assert.equal(retry.row().registrationPending, false); assert.equal(retry.row().roleId, null); assert.equal(retry.saves(), 0);
});
