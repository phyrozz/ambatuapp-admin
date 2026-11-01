import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { apiLimitFor, clientIpHeader, trustedClientIp } from './api-rate-limit.ts';

test('uses separate read, write and expensive write budgets', () => {
  assert.deepEqual(apiLimitFor('GET', '/api/public/videos/presign'), { action: 'apiRead', max: 300, windowMs: 60_000 });
  assert.deepEqual(apiLimitFor('POST', '/api/public/videos'), { action: 'apiWrite', max: 60, windowMs: 60_000 });
  assert.deepEqual(apiLimitFor('POST', '/api/public/videos/presign'), { action: 'apiExpensiveWrite', max: 20, windowMs: 60_000 });
  assert.equal(apiLimitFor('POST', '/api/public/videos/transcode').action, 'apiExpensiveWrite');
});

test('accepts only a single IP from the explicitly configured header', () => {
  const headers = new Headers({ 'x-forwarded-for': '198.51.100.1', 'x-client-ip': '2001:db8::1' });
  assert.equal(trustedClientIp(headers, undefined), null);
  assert.equal(trustedClientIp(headers, 'x-client-ip'), '2001:db8::1');
  assert.equal(trustedClientIp(new Headers({ 'x-client-ip': '2001:0db8:0:0:0:0:0:1' }), 'x-client-ip'), '2001:db8::1');
  assert.equal(trustedClientIp(new Headers({ 'x-client-ip': '198.51.100.1, 198.51.100.2' }), 'x-client-ip'), null);
  assert.equal(trustedClientIp(new Headers({ 'x-client-ip': 'not-an-ip' }), 'x-client-ip'), null);
});

test('selects Vercel client IP header only on Vercel unless overridden', () => {
  assert.equal(clientIpHeader(undefined, '1'), 'x-vercel-forwarded-for');
  assert.equal(clientIpHeader(undefined, undefined), undefined);
  assert.equal(clientIpHeader('x-trusted-client-ip', '1'), 'x-trusted-client-ip');
});
