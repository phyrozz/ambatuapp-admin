import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const sent = [];
class PutObjectCommand { constructor(input) { this.input = input; } }
class DeleteObjectCommand { constructor(input) { this.input = input; } }
const module = { exports: {} };
const code = ts.transpileModule(readFileSync(new URL('./scroll-ads.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mocks = {
  'node:crypto': { randomUUID: () => '12345678-1234-1234-1234-123456789abc' },
  '@aws-sdk/client-s3': { PutObjectCommand, DeleteObjectCommand },
  './dev-content-db': { withDevVideoDb: async () => {} },
  './s3-videos': { videoBucket: () => 'bucket', videoClient: () => ({ send: async command => sent.push(command) }), signedVideoUrl: async key => `https://signed.example/${key}` },
};
vm.runInNewContext(code, { module, exports: module.exports, require: name => mocks[name], URL, Uint8Array, String, Error, FormData, File });
const { uploadAdImage, deleteAdImage, formFields, hydrateAd } = module.exports;

test('validates image signatures and size before uploading', async () => {
  sent.length = 0;
  await assert.rejects(uploadAdImage(new File(['not a png'], 'bad.png', { type: 'image/png' })), /valid PNG/);
  await assert.rejects(uploadAdImage(new File([new Uint8Array(3 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' })), /3 MB/);
  assert.equal(sent.length, 0);
  const key = await uploadAdImage(new File([new Uint8Array([137,80,78,71,13,10,26,10])], 'banner.png', { type: 'image/png' }));
  assert.match(key, /^scroll-ads\/.+\.png$/);
  assert.equal(sent[0].input.ContentType, 'image/png');
  assert.equal(sent[0].input.Key, key);
});

test('signs stored keys, preserves legacy links, and deletes only owned images', async () => {
  sent.length = 0;
  const ad = { id:'a', title:'A', imageUrl:'scroll-ads/a.png', destinationUrl:'https://example.com', active:true };
  assert.equal((await hydrateAd(ad)).imageUrl, 'https://signed.example/scroll-ads/a.png');
  assert.equal((await hydrateAd({ ...ad, imageUrl:'https://example.com/old.png' })).imageUrl, 'https://example.com/old.png');
  await deleteAdImage('https://example.com/old.png');
  assert.equal(sent.length, 0);
  await deleteAdImage(ad.imageUrl);
  assert.equal(sent[0].input.Key, ad.imageUrl);
});

test('validates banner fields and rejects unsafe destination URLs', () => {
  const form = new FormData(); form.set('title', ' Banner '); form.set('destinationUrl', 'https://example.com'); form.set('active', 'true');
  assert.equal(formFields(form).title, 'Banner');
  form.set('destinationUrl', 'javascript:alert(1)');
  assert.throws(() => formFields(form), /HTTPS/);
});
