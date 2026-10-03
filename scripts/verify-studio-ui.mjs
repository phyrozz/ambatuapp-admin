import { chromium } from '../../revamp/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import { rootPermissions } from '../src/lib/studio-policy.mjs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const output = fileURLToPath(new URL('../../.tmp/studio-ui/', import.meta.url));
await mkdir(output, { recursive: true });
const baseUrl = process.env.STUDIO_TEST_BASE_URL || 'http://localhost:3010';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const profile = { sub: 'root-self', username: 'root@example.com', email: 'root@example.com', displayName: 'Studio Root', firstName: 'Studio', lastName: 'Root', country: 'Indonesia', bio: '', enabled: true, roleId: 'root' };
let permissions = rootPermissions(), roleId = 'root', rolePosts = 0, userPosts = 0, rolePages = 0, registrationTest = false, registered = false, signUps = 0, confirmations = 0;
const jwt = payload => Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url') + '.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.fixture';
await page.route('https://cognito-idp.*.amazonaws.com/**', async route => {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' } });
  const target = route.request().headers()['x-amz-target']?.split('.').at(-1);
  let result = {};
  if (target === 'SignUp') { signUps++; const data = route.request().postDataJSON(); assert.deepEqual(data.UserAttributes, [{ Name: 'email', Value: 'ada@example.com' }]); result = { UserConfirmed: false, UserSub: 'new-user', CodeDeliveryDetails: { Destination: 'a***@example.com', DeliveryMedium: 'EMAIL', AttributeName: 'email' } }; }
  else if (target === 'ConfirmSignUp') { confirmations++; assert.equal(route.request().postDataJSON().ConfirmationCode, '123456'); }
  else if (target === 'InitiateAuth' || target === 'GetTokensFromRefreshToken') {
    const base = { sub: 'new-user', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) };
    result = { AuthenticationResult: { IdToken: jwt({ ...base, token_use: 'id', 'cognito:username': 'ada@example.com', email: 'ada@example.com', email_verified: true, aud: 'studiotest123', 'cognito:groups': registered ? ['Admins'] : [] }), AccessToken: jwt({ ...base, token_use: 'access', username: 'ada@example.com', client_id: 'studiotest123' }), RefreshToken: 'fixture-refresh', ExpiresIn: 3600, TokenType: 'Bearer' } };
  } else if (target !== 'GlobalSignOut') throw new Error(`Unexpected Cognito action: ${target}`);
  await route.fulfill({ status: 200, contentType: 'application/x-amz-json-1.1', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(result) });
});
let roles = [{ id: 'root', name: 'Root', protected: true, userCount: 1, description: '', permissions: rootPermissions() }, { id: 'editor', name: 'Character editor', protected: false, userCount: 0, description: 'Manage characters', permissions: { characters: ['view', 'edit'] } }];
await page.route('**/api/**', async route => {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  let body = {};
  if (url.pathname === '/api/admin-session') {
    if (registrationTest && !registered) return route.fulfill({ status: 403, json: { error: 'studio.errors.forbidden' } });
    body = { authorized: true, permissions, roleId, roleName: 'Viewer', profile };
  }
  else if (url.pathname === '/api/studio-registration') { const data = request.postDataJSON(); assert.equal(data.firstName, 'Ada'); assert.equal(data.roleId, undefined); assert.equal(data.password, undefined); registered = true; body = { registered: true }; }
  else if (url.pathname === '/api/roles' && method === 'GET') { rolePages++; body = url.searchParams.has('cursor') ? { items: [{ id: 'extra-role', name: 'Extra role', userCount: 0, permissions: { lores: ['view'] } }], nextCursor: null } : { items: roles, nextCursor: 'editor' }; }
  else if (url.pathname === '/api/roles' && method === 'POST') { rolePosts++; const data = request.postDataJSON(); assert.deepEqual(data.permissions.characters, ['view', 'add']); roles.push({ ...data, id: 'new-role', userCount: 0 }); body = roles.at(-1); }
  else if (url.pathname === '/api/users/role-options') body = { items: roles.map(role => ({ id: role.id, name: role.name })), nextCursor: null };
  else if (url.pathname === '/api/users' && method === 'GET') body = { items: [profile, { ...profile, sub: 'contributor', email: 'ada@example.com', username: 'ada@example.com', displayName: 'Ada Contributor', roleId: null }], nextCursor: null };
  else if (url.pathname === '/api/users' && method === 'POST') { userPosts++; const data = request.postDataJSON(); assert.equal(data.password, data.confirmPassword); assert.equal(data.roleId, 'editor'); assert.equal(data.firstName, 'Ada'); body = { ...data, sub: 'new-user' }; }
  else if (url.pathname === '/api/characters') body = { characters: [{ id: 'character1', name: 'Test character', title: 'Test title', bio: 'Biography', status: 'Draft', tags: [], updated: 'Today' }] };
  else if (url.pathname === '/api/lores') body = { lores: [] };
  else if (url.pathname === '/api/videos') body = { videos: [] };
  else if (url.pathname === '/api/sounds') body = { sounds: [] };
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});
try {
  await page.goto(baseUrl + '/roles');
  await page.getByRole('button', { name: 'Add role', exact: true }).click();
  await page.getByLabel('Role name', { exact: true }).fill('Contributor');
  await page.getByLabel('Add access for Characters', { exact: true }).check();
  assert.equal(await page.getByLabel('View access for Characters', { exact: true }).isChecked(), true);
  assert.equal(await page.getByLabel('Upload access for Characters', { exact: true }).isChecked(), false);
  await page.screenshot({ path: output + '/roles-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('Changes saved.', { exact: true }).waitFor();
  assert.equal(rolePosts, 1);
  await page.locator('.studio-list-sentinel').last().scrollIntoViewIfNeeded();
  await page.getByRole('heading', { name: 'Extra role' }).waitFor();
  assert.ok(rolePages >= 2);
  await page.goto(baseUrl + '/users');
  await page.getByRole('button', { name: 'Add user', exact: true }).click();
  for (const [label, value] of [['First name', 'Ada'], ['Last name', 'Contributor'], ['Display name', 'Ada'], ['Country or region', 'Indonesia'], ['Email address', 'new@example.com'], ['Password', 'Example123!'], ['Confirm password', 'Example123!']]) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByLabel('Role', { exact: true }).selectOption('editor');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: output + '/users-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.locator('form').getByRole('button', { name: 'Add user', exact: true }).click();
  await page.getByText('User created. They can sign in with the password you provided.', { exact: true }).waitFor();
  assert.equal(userPosts, 1);
  permissions = { characters: ['view'] }; roleId = 'viewer';
  await page.goto(baseUrl + '/');
  // The home auth gate uses a real session, so verify a restricted module through its standalone page.
  await page.goto(baseUrl + '/roles');
  await page.getByText('Your role does not have View access to this module. Choose an available module from the menu.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Add role', exact: true }).count(), 0);
  permissions = {}; roleId = null;
  await page.goto(baseUrl + '/users');
  await page.getByRole('heading', { name: 'Welcome to the studio' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Add user', exact: true }).count(), 0);
  await page.goto(baseUrl + '/');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  for (const label of ['First name', 'Last name', 'Display name', 'Country or region', 'Email address', 'Password', 'Confirm password']) assert.equal(await page.getByLabel(label, { exact: true }).count(), 1);
  await page.getByLabel('First name', { exact: true }).fill('Ada');
  await page.getByLabel('Last name', { exact: true }).fill('Contributor');
  await page.getByLabel('Display name', { exact: true }).fill('Ada');
  await page.getByLabel('Country or region', { exact: true }).fill('Indonesia');
  await page.getByLabel('Email address', { exact: true }).fill('ada@example.com');
  await page.getByLabel('Password', { exact: true }).fill('Example123!');
  await page.getByLabel('Confirm password', { exact: true }).fill('Different123!');
  await page.screenshot({ path: output + '/register-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByText('Passwords do not match.', { exact: true }).waitFor();
  registrationTest = true;
  await page.getByLabel('Confirm password', { exact: true }).fill('Example123!');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('heading', { name: 'Verify your email', exact: true }).waitFor();
  await page.getByLabel('Verification code', { exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Verify email', exact: true }).click();
  await page.getByRole('heading', { name: 'Sign in to the studio', exact: true }).waitFor();
  await page.getByLabel('Password', { exact: true }).fill('Example123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Complete your studio profile', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Complete profile', exact: true }).click();
  await page.getByRole('heading', { name: 'Welcome to the studio', exact: true }).waitFor();
  assert.equal(signUps, 1); assert.equal(confirmations, 1); assert.equal(registered, true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: ['role permission matrix', 'role creation', 'cursor append', 'matching user fields and role dropdown', 'manual creation', 'restricted module', 'unassigned account', 'registration fields', 'password confirmation', 'mobile overflow', 'Cognito signup with email only', 'email confirmation', 'signin and profile completion', 'pending-role landing'], rolePosts, userPosts, rolePages, signUps, confirmations }));
} finally { await browser.close(); }
