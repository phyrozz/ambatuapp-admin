import assert from 'node:assert/strict';
import test from 'node:test';
import { ROLE_TYPES, STUDIO_MODULES, canAccess, normalizePermissions, permissionForRequest, rootPermissions, validateCredentials, validateProfile } from './studio-policy.mjs';
test('Root covers every module and all six actions, and denies unknown permissions', () => {
  const permissions = rootPermissions();
  assert.equal(STUDIO_MODULES.length, 8);
  assert.deepEqual(ROLE_TYPES, ['view', 'add', 'edit', 'delete', 'upload', 'download']);
  for (const studioModule of STUDIO_MODULES) for (const action of ROLE_TYPES) assert.equal(canAccess(permissions, studioModule.id, action), true);
  assert.equal(canAccess(permissions, 'future-unknown', 'view'), false);
  assert.equal(canAccess(permissions, 'characters', 'execute'), false);
});
test('Unassigned and view-only contributors cannot mutate content or manage users', () => {
  for (const action of ROLE_TYPES) assert.equal(canAccess({}, 'characters', action), false);
  const permissions = normalizePermissions({ characters: ['view'] });
  assert.equal(canAccess(permissions, 'characters', 'view'), true);
  for (const action of ROLE_TYPES.filter(action => action !== 'view')) assert.equal(canAccess(permissions, 'characters', action), false);
  assert.equal(canAccess(permissions, 'users', 'view'), false);
});
test('Permission validation rejects unknown modules, actions, missing View, and malformed grants', () => {
  for (const value of [null, [], { hidden: ['view'] }, { characters: ['owner'] }, { characters: 'view' }, { characters: ['edit'] }, { roles: ['delete', 'upload'] }]) assert.throws(() => normalizePermissions(value));
  assert.deepEqual(normalizePermissions({ characters: ['view', 'view', 'add'] }).characters, ['view', 'add']);
});
test('Every existing private endpoint maps to a module and specific action', () => {
  for (const studioModule of STUDIO_MODULES) {
    assert.deepEqual(permissionForRequest(`/api/${studioModule.id}`, 'GET'), { module: studioModule.id, action: 'view' });
    assert.deepEqual(permissionForRequest(`/api/${studioModule.id}`, 'POST'), { module: studioModule.id, action: 'add' });
    assert.deepEqual(permissionForRequest(`/api/${studioModule.id}/record`, 'PATCH'), { module: studioModule.id, action: 'edit' });
    assert.deepEqual(permissionForRequest(`/api/${studioModule.id}/record`, 'DELETE'), { module: studioModule.id, action: 'delete' });
  }
  assert.deepEqual(permissionForRequest('/api/admin-users', 'POST'), { module: 'users', action: 'add' });
  assert.deepEqual(permissionForRequest('/api/profile-avatar-moderation/user', 'PATCH'), { module: 'profile-avatars', action: 'edit' });
  assert.deepEqual(permissionForRequest('/api/chat-restrictions', 'PATCH'), { module: 'chat-reports', action: 'edit' });
  assert.deepEqual(permissionForRequest('/api/videos/transcode', 'GET'), { module: 'videos', action: 'upload' });
  assert.deepEqual(permissionForRequest('/api/sounds/presign', 'POST'), { module: 'sounds', action: 'upload' });
  assert.deepEqual(permissionForRequest('/api/characters/bulk-upload', 'POST'), { module: 'characters', action: 'upload' });
  assert.deepEqual(permissionForRequest('/api/lores/download', 'GET'), { module: 'lores', action: 'download' });
  assert.equal(permissionForRequest('/api/admin-session', 'GET'), null);
  assert.throws(() => permissionForRequest('/api/new-unguarded-endpoint', 'POST'));
});
test('Personal details accept only profile fields, never role or permissions supplied on registration', () => {
  const valid = { firstName: '  Ada ', lastName: 'Lovelace', displayName: 'Ada', country: 'United Kingdom', bio: 'Contributor', roleId: 'root', permissions: rootPermissions() };
  assert.deepEqual(validateProfile(valid), { firstName: 'Ada', lastName: 'Lovelace', displayName: 'Ada', country: 'United Kingdom', bio: 'Contributor' });
  assert.throws(() => validateProfile({ ...valid, firstName: '' }));
  assert.throws(() => validateProfile({ ...valid, bio: 'a'.repeat(1001) }));
});
test('Manual creation rejects invalid email and mismatched or short passwords before Cognito writes', () => {
  const valid = { email: ' ADA@example.com ', password: 'Example123!', confirmPassword: 'Example123!' };
  assert.deepEqual(validateCredentials(valid), { email: 'ada@example.com', password: 'Example123!' });
  assert.throws(() => validateCredentials({ ...valid, confirmPassword: 'different' }));
  assert.throws(() => validateCredentials({ ...valid, password: 'short', confirmPassword: 'short' }));
  assert.throws(() => validateCredentials({ ...valid, email: 'bad-email' }));
});
