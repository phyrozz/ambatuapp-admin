import assert from 'node:assert/strict';
const base = process.env.SOCIAL_API_BASE ?? 'http://localhost:3000/api/public';
for (const path of ['/friends', '/friends?state=accepted&pinned=true', '/friends/test-user', '/friends/summary', '/friends/search?q=test&state=accepted', '/scroll', '/scroll/test/comments']) {
  for (const headers of [{}, { authorization: 'Bearer invalid-token' }]) {
    const response = await fetch(`${base}${path}`, { headers });
    assert.equal(response.status, 401, `${path} must reject missing/invalid Cognito tokens`);
    assert.deepEqual(await response.json(), { error: 'UNAUTHORIZED' });
  }
  const options = await fetch(`${base}${path}`, { method: 'OPTIONS' });
  assert.equal(options.status, 200);
  assert.match(options.headers.get('access-control-allow-headers'), /authorization/);
}
const mutation = await fetch(`${base}/friends`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId: 'test', action: 'request' }) });
assert.equal(mutation.status, 401);
for (const action of ['pin', 'unpin']) {
  const response = await fetch(`${base}/friends`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId: 'test', action }) });
  assert.equal(response.status, 401);
}
for (const path of ['/scroll/test/vote', '/scroll/test/comments', '/scroll/test/comments/test/vote']) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 1, text: 'test' }) });
  assert.equal(response.status, 401, `${path} must reject unauthenticated mutations`);
  const options = await fetch(`${base}${path}`, { method: 'OPTIONS' });
  assert.equal(options.status, 200);
}
console.log('Passed: all social reads and mutations reject unauthenticated requests; invalid tokens rejected; CORS preflights supported.');
