import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

globalThis.AsyncLocalStorage ??= AsyncLocalStorage;
const require = createRequire(import.meta.url);
const { unstable_doesMiddlewareMatch } = require('next/experimental/testing/server');
const source = readFileSync(new URL('../proxy.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, Response,
  require: () => ({ NextResponse: { next: () => 'next' } }) });

test('maintenance freezes API routes except read-only health checks', async () => {
  for (const path of ['/api', '/api/health', '/api/public/videos/123/vote', '/api/public/players']) {
    assert.equal(unstable_doesMiddlewareMatch({ config: mod.exports.config, nextConfig: {}, url: path }), true);
    for (const method of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS']) {
      const result = mod.exports.proxy({ nextUrl: { pathname: path }, method });
      if (path === '/api/health' && ['GET', 'HEAD'].includes(method)) assert.equal(result, 'next');
      else {
        assert.equal(result.status, 503);
        assert.equal((await result.json()).error, 'MAINTENANCE');
      }
    }
  }
});
