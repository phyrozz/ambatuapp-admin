import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
class NextResponse extends Response { static json(value, options) { return new NextResponse(JSON.stringify(value), options); } }
function fixture(fail) {
  const calls = [], module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL('../app/api/scroll-ads/route.ts', import.meta.url), 'utf8'), { compilerOptions:{ module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022 } }).outputText;
  const deps = {
    'next/server': { NextResponse },
    '../../../lib/api-auth': { requireAdmin: async (_request, permission) => calls.push(permission?.action ?? 'add') },
    '../../../lib/studio-api': { adminErrorStatus: (_error, fallback) => fallback },
    '../../../lib/scroll-ads': {
      formFields: () => ({ title:'Banner', destinationUrl:'https://example.com', active:true }),
      uploadAdImage: async () => { calls.push('upload'); return 'scroll-ads/test.png'; },
      createUploadedAd: async () => { calls.push('save'); if (fail) throw new Error('database failed'); return { id:'a' }; },
      hydrateAd: async ad => ad,
      deleteAdImage: async key => { if (key) calls.push(`delete:${key}`); },
    },
  };
  vm.runInNewContext(code, { module, exports:module.exports, require: name => deps[name], File, Response, Error });
  return { POST:module.exports.POST, calls };
}
function request() { const form = new FormData(); form.set('image', new File(['data'], 'test.png', { type:'image/png' })); return new Request('https://example.com/api/scroll-ads', { method:'POST', body:form }); }
test('requires upload permission and saves the uploaded image', async () => {
  const f = fixture(false), response = await f.POST(request());
  assert.equal(response.status, 201);
  assert.deepEqual(f.calls, ['add', 'upload', 'upload', 'save']);
});
test('cleans up the uploaded image if saving fails', async () => {
  const f = fixture(true), response = await f.POST(request());
  assert.equal(response.status, 400);
  assert.equal(f.calls.at(-1), 'delete:scroll-ads/test.png');
});
