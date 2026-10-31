import assert from 'node:assert/strict';
import test from 'node:test';
import { healthRateLimit } from './health-rate-limit.ts';

test('limits health checks and resets after the window', () => {
  for (let i = 0; i < 60; i++) assert.equal(healthRateLimit(1_000), null);
  assert.equal(healthRateLimit(1_000), 60);
  assert.equal(healthRateLimit(60_999), 1);
  assert.equal(healthRateLimit(61_000), null);
});
