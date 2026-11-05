import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Exercise the actual handlers without credentials or production mutations.
function fixture({ authenticated = true, configurationError, writeError, found = true } = {}) {
  const logs = [], writes = [];
  const write = async (...args) => {
    writes.push(args);
    if (writeError) throw writeError;
    return found;
  };
  const dependencies = {
    'next/server': { NextResponse: Response },
    'firebase-admin/firestore': {},
    'dev-content-db': { isDevVideoWriter: () => {
      if (configurationError) throw configurationError;
      return true;
    } },
    'dev-videos': { editPlayerVideo: write, deleteManagedVideo: write },
    'firebase-admin': { adminDb: null },
    'player-auth': { requirePlayer: async () => {
      if (!authenticated) throw new Error('Unauthorized');
      return { id: 'owner' };
    } },
    'public-write-limits': { allowPlayerWrite: async () => true },
  };
  const mod = { exports: {} };
  const source = readFileSync(new URL('../app/api/public/videos/[id]/route.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports,
    require: name => dependencies[name] ?? dependencies[name.split('/').at(-1)] ?? {},
    console: { error: (...args) => logs.push(args) },
  });
  return { route: mod.exports, logs, writes };
}

function request(method, body = { title: 'Updated title', description: 'Updated description' }) {
  return new Request('https://api.example.test/api/public/videos/video-1', {
    method,
    headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
    ...(method === 'PATCH' ? { body: JSON.stringify(body) } : {}),
  });
}
const context = () => ({ params: Promise.resolve({ id: 'video-1' }) });

test('video edit preflight permits PATCH and its authorization and JSON headers', () => {
  const { route, writes, logs } = fixture({ configurationError: new Error('unavailable') });
  const response = route.OPTIONS();
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('access-control-allow-methods'), /\bPATCH\b/);
  assert.match(response.headers.get('access-control-allow-headers'), /authorization/);
  assert.match(response.headers.get('access-control-allow-headers'), /content-type/);
  assert.equal(writes.length, 0);
  assert.equal(logs.length, 0);
});

for (const method of ['PATCH', 'DELETE']) {
  test(`${method} returns a readable unauthorized response without writing`, async () => {
    const { route, writes } = fixture({ authenticated: false });
    const response = await route[method](request(method), context());
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), { error: 'UNAUTHORIZED' });
    assert.equal(writes.length, 0);
  });

  for (const failure of ['configurationError', 'writeError']) {
    test(`${method} logs ${failure} and returns JSON with CORS`, async () => {
      const error = new Error('Database unavailable');
      const { route, logs } = fixture({ [failure]: error });
      const response = await route[method](request(method), context());
      assert.equal(response.status, 500);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), {
        error: method === 'PATCH' ? 'VIDEO_UPDATE_FAILED' : 'VIDEO_DELETE_FAILED',
      });
      assert.equal(logs.length, 1);
      assert.equal(logs[0][1], error);
    });
  }
}

test('successful edits retain the authenticated owner and trim metadata', async () => {
  const { route, writes, logs } = fixture();
  const response = await route.PATCH(request('PATCH', { title: ' New title ', description: ' Description ' }), context());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 'video-1', title: 'New title', description: 'Description' });
  assert.deepEqual(writes[0], ['owner', 'video-1', 'New title', 'Description']);
  assert.equal(logs.length, 0);
});

test('missing or unowned videos still return 404', async () => {
  const { route } = fixture({ found: false });
  const response = await route.PATCH(request('PATCH'), context());
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'VIDEO_NOT_FOUND' });
});
