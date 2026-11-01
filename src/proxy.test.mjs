import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { apiLimitFor, clientIpHeader, createLocalApiLimiter, trustedClientIp } from './lib/api-rate-limit.ts';

function setup(storeUnavailable = false, env = { API_RATE_LIMIT_TRUSTED_IP_HEADER: 'x-client-ip' }) {
  const counts = new Map();
  const mocks = {
    'next/server': { NextResponse: { next: () => ({ status: 200 }), json: (body, options) => ({ body, ...options }) } },
    './lib/api-rate-limit': { apiLimitFor, clientIpHeader, createLocalApiLimiter, trustedClientIp },
    './lib/api-auth': { requireStudioIdentity: async () => null },
    './lib/firebase-admin': { adminDb: {} },
    './lib/player-auth': { playerFromRequest: async request => {
      const token = request.headers.get('authorization');
      return token === 'valid-a' ? { id: 'a' } : token === 'valid-b' ? { id: 'b' } : null;
    } },
    './lib/public-write-limits': { allowPlayerWrite: async (_db, identity, action, limits) => {
      if (storeUnavailable) throw new Error('unavailable');
      const key = `${identity}:${action}`;
      const count = counts.get(key) ?? 0;
      if (count >= limits[0].max) return false;
      counts.set(key, count + 1);
      return true;
    } },
  };
  const module = { exports: {} };
  const source = readFileSync(new URL('./proxy.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: name => mocks[name], process: { env } });
  return module.exports.proxy;
}

function request(method, path, headers = {}) {
  return { method, nextUrl: { pathname: path }, headers: new Headers(headers) };
}

test('verified users have independent budgets and public denials support CORS', async () => {
  const proxy = setup();
  const a = request('POST', '/api/public/profile', { authorization: 'valid-a' });
  for (let i = 0; i < 60; i++) assert.equal((await proxy(a)).status, 200);
  const denied = await proxy(a);
  assert.equal(denied.status, 429);
  assert.equal(denied.headers['Retry-After'], '60');
  assert.equal(denied.headers['Access-Control-Allow-Origin'], '*');
  assert.equal((await proxy(request('POST', '/api/public/profile', { authorization: 'valid-b' }))).status, 200);
  assert.equal((await proxy(request('GET', '/api/public/profile', { authorization: 'valid-a' }))).status, 200);
});

test('invalid credentials use the trusted IP and missing identity fails closed', async () => {
  const proxy = setup();
  assert.equal((await proxy(request('GET', '/api/public/profile', { authorization: 'invalid' }))).status, 503);
  assert.equal((await proxy(request('GET', '/api/public/profile', { authorization: 'invalid', 'x-client-ip': '192.0.2.1' }))).status, 200);
  assert.equal((await proxy(request('OPTIONS', '/api/public/profile'))).status, 200);
});

test('an unavailable shared store returns 503 rather than bypassing the limit', async () => {
  const proxy = setup(true);
  assert.equal((await proxy(request('POST', '/api/public/profile', { authorization: 'valid-a' }))).status, 503);
});

test('local development limits anonymous traffic without a proxy or shared store', async () => {
  const proxy = setup(true, { NODE_ENV: 'development' });
  const anonymous = request('POST', '/api/public/profile');
  for (let i = 0; i < 60; i++) assert.equal((await proxy(anonymous)).status, 200);
  assert.equal((await proxy(anonymous)).status, 429);
  assert.equal((await proxy(request('GET', '/api/public/profile'))).status, 200);
});

test('local fallback is disabled in production, on Vercel, and with a configured proxy', async () => {
  for (const env of [
    { NODE_ENV: 'production' },
    { NODE_ENV: 'development', VERCEL: '1' },
    { NODE_ENV: 'development', API_RATE_LIMIT_TRUSTED_IP_HEADER: 'x-client-ip' },
  ]) {
    assert.equal((await setup(false, env)(request('GET', '/api/public/profile'))).status, 503);
  }
});
