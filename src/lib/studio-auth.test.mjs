import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as policy from './studio-policy.mjs';
const source = await readFile(new URL('./api-auth.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function auth({ permissions = {}, member = true, configured = true, validToken = true, production = true, postgresStudio = false } = {}) {
  const exports = {}, env = { NODE_ENV: production ? 'production' : 'development', ...(configured ? { COGNITO_ADMIN_USER_POOL_ID: 'test_pool', NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID: 'test-client' } : {}) };
  vm.runInNewContext(compiled, { exports, process: { env }, URL, require: name => {
    if (name === 'aws-jwt-verify') return { CognitoJwtVerifier: { create: () => ({ verify: async () => { if (!validToken) throw new Error('Invalid JWT'); return { sub: 'studio-user', 'cognito:username': 'user', email: 'user@example.com', email_verified: true }; } }) } };
    if (name === './cognito-admins') return { isCurrentAdmin: async () => member };
    if (name === './studio-access') return { getStudioAccess: async () => ({ permissions, roleId: 'test-role', profile: {} }) };
    if (name === './dev-content-db') return { isDevStudioWriter: () => postgresStudio };
    if (name === './studio-policy.mjs') return policy;
    throw new Error(`Unexpected dependency ${name}`);
  } });
  return exports;
}
const request = (path, method = 'GET', token = true) => new Request(`http://studio.test${path}`, { method, headers: token ? { authorization: 'Bearer token' } : {} });
test('Authorization fails closed for missing configuration, token, invalid JWT, or revoked membership', async () => {
  await assert.rejects(auth({ configured: false }).requireAdmin(request('/api/characters')), /authConfiguration/);
  await assert.rejects(auth().requireAdmin(request('/api/characters', 'GET', false)), /unauthorized/);
  await assert.rejects(auth({ validToken: false }).requireAdmin(request('/api/characters')), /unauthorized/);
  await assert.rejects(auth({ member: false, permissions: policy.rootPermissions() }).requireAdmin(request('/api/characters')), /forbidden/);
  await assert.rejects(auth({ configured: false, production: false, postgresStudio: true }).requireAdmin(request('/api/characters')), /authConfiguration/);
});
test('View-only grants allow reads and reject direct Add/Edit/Delete/Upload requests', async () => {
  const api = auth({ permissions: { characters: ['view'], videos: ['view'] } });
  assert.equal((await api.requireAdmin(request('/api/characters'))).sub, 'studio-user');
  for (const [path, method] of [['/api/characters', 'POST'], ['/api/characters/id', 'PATCH'], ['/api/characters/id', 'DELETE'], ['/api/videos/presign', 'POST'], ['/api/videos/transcode', 'GET'], ['/api/users', 'GET']]) await assert.rejects(api.requireAdmin(request(path, method)), /forbidden/);
});
test('Scope-specific uploads check their own module and pending users can only load their session', async () => {
  const api = auth({ permissions: { characters: ['view', 'upload'] } });
  await api.requireAdmin(request('/api/character-images/presign', 'POST'), { module: 'characters', action: 'upload' });
  await assert.rejects(api.requireAdmin(request('/api/character-images/presign', 'POST'), { module: 'lores', action: 'upload' }), /forbidden/);
  const pending = auth();
  await pending.requireAdmin(request('/api/admin-session'));
  await assert.rejects(pending.requireAdmin(request('/api/roles')), /forbidden/);
});
