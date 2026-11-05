import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function fixture({ authorized = true, enabled = true, found = true, invalidCursor = false } = {}) {
  const calls = [];
  const load = path => {
    const mod = { exports: {} };
    const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(code, { module: mod, exports: mod.exports, URL, Error, Buffer, require: name => {
      if (name === 'next/server') return { NextResponse: class extends Response { static json = Response.json; } };
      if (name.endsWith('/player-auth')) return { requirePlayer: async () => { if (!authorized) throw new Error(); return { id: 'verified-player' }; } };
      if (name.endsWith('/dev-content-db')) return { isDevVideoWriter: () => enabled };
      if (name.endsWith('/personalized-scroll')) return {
        listPersonalizedScroll: async (...args) => { calls.push(args); if (invalidCursor) throw new Error('INVALID_CURSOR'); return { videos: [], nextCursor: null }; },
        recordScrollWatch: async (...args) => { calls.push(args); return found; },
      };
      if (name.endsWith('/scroll-ranking')) return load('./scroll-ranking.ts');
      throw new Error(`Unexpected dependency: ${name}`);
    } });
    return mod.exports;
  };
  return { calls, feed: load('../app/api/public/scroll/route.ts'), watch: load('../app/api/public/scroll/[id]/watch/route.ts') };
}
const request = (body, token = 'test') => new Request('https://local.invalid/api/public/scroll/clip/watch', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const context = { params: Promise.resolve({ id: 'clip' }) };

test('both routes reject unauthenticated requests before accessing storage', async () => {
  const f = fixture({ authorized: false });
  assert.equal((await f.feed.GET(new Request('https://local.invalid/scroll'))).status, 401);
  assert.equal((await f.watch.POST(request({ watchedMs: 1000, durationMs: 10000 }), context)).status, 401);
  assert.equal(f.calls.length, 0);
});
test('watch ownership comes only from the verified token; payload and published status are enforced', async () => {
  const f = fixture();
  assert.equal((await f.watch.POST(request({ watchedMs: 1000, durationMs: 10000, playerId: 'someone-else' }), context)).status, 200);
  assert.equal(f.calls[0][0], 'verified-player');
  assert.equal(f.calls[0][1], 'clip');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0][2])), { watchedMs: 1000, durationMs: 10000 });
  assert.equal((await f.watch.POST(request({ watchedMs: 99999999, durationMs: 10000 }), context)).status, 400);
  assert.equal((await f.watch.POST(request({ watchedMs: 1000, durationMs: 10000 }), { params: Promise.resolve({ id: '../private' }) })).status, 400);
  assert.equal((await fixture({ found: false }).watch.POST(request({ watchedMs: 1000, durationMs: 10000 }), context)).status, 404);
});
test('feed uses PostgreSQL only, validates cursors, and supports uncached browser/native requests', async () => {
  const f = fixture();
  const result = await f.feed.GET(new Request('https://local.invalid/scroll?cursor=abc'));
  assert.equal(result.status, 200);
  assert.deepEqual(f.calls[0], ['verified-player', 'abc']);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(f.watch.OPTIONS().headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal((await fixture({ invalidCursor: true }).feed.GET(new Request('https://local.invalid/scroll?cursor=bad'))).status, 400);
  assert.equal((await fixture({ enabled: false }).feed.GET(new Request('https://local.invalid/scroll'))).status, 503);
});
