import test from 'node:test';
import assert from 'node:assert/strict';
import { exportFirestore } from './firestore-export-core.mjs';

test('exports paginated documents and descendants of missing parents with typed values', async () => {
  const root = 'projects/demo/databases/(default)/documents';
  const calls = [];
  let csv = '';
  const result = await exportFirestore({ project: 'demo', maxDocuments: 3, write: async s => { csv += s; }, request: async (path, options = {}) => {
    calls.push(path);
    if (path.endsWith(':listCollectionIds')) {
      if (path.includes('/missing:')) return { collectionIds: ['children'] };
      if (path.endsWith('documents:listCollectionIds')) return { collectionIds: ['items'] };
      return {};
    }
    if (path.includes('/children?')) return { documents: [{ name: `${root}/items/missing/children/c`, createTime: 'time', fields: { n: { integerValue: '9223372036854775807' } } }] };
    if (path.includes('pageToken=next')) return { documents: [{ name: `${root}/items/b`, createTime: 'time', fields: {} }] };
    return { documents: [{ name: `${root}/items/missing` }, { name: `${root}/items/a`, createTime: 'time', fields: { s: { stringValue: 'hello' } } }], nextPageToken: 'next' };
  } });
  assert.equal(result.count, 3);
  assert.match(csv, /items\/missing\/children\/c/);
  assert.match(csv, /9223372036854775807/);
  assert.doesNotMatch(csv, /"items\/missing",/);
  assert.ok(calls.some(path => path.includes('pageToken=next')));
});

test('fails rather than reporting success when document limit is exceeded', async () => {
  const root = 'projects/demo/databases/(default)/documents';
  await assert.rejects(exportFirestore({ project: 'demo', maxDocuments: 1, write: async () => {}, request: async path => {
    if (path.endsWith('documents:listCollectionIds')) return { collectionIds: ['items'] };
    if (path.endsWith(':listCollectionIds')) return {};
    return { documents: [{ name: `${root}/items/a`, createTime: 't' }, { name: `${root}/items/b`, createTime: 't' }] };
  } }), /limit 1 exceeded/);
});
