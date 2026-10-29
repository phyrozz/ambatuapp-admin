// Firestore REST returns typed Value objects, including integerValue as a string.
const csv = value => `"${value.replaceAll('"', '""')}"`;
const urlPath = path => path.split('/').map(encodeURIComponent).join('/');

export async function exportFirestore({ project, database = '(default)', maxDocuments, request, write }) {
  const root = `projects/${project}/databases/${database}/documents`;
  let count = 0;
  const counts = {};
  await write('path,document\n');

  async function visit(parent) {
    let collectionToken;
    do {
      const body = { pageSize: 100, ...(collectionToken ? { pageToken: collectionToken } : {}) };
      const collections = await request(`/v1/${urlPath(parent)}:listCollectionIds`, { method: 'POST', body });
      for (const collection of collections.collectionIds ?? []) {
        let documentToken;
        do {
          const query = new URLSearchParams({ pageSize: '100', showMissing: 'true' });
          if (documentToken) query.set('pageToken', documentToken);
          const page = await request(`/v1/${urlPath(parent)}/${encodeURIComponent(collection)}?${query}`);
          for (const doc of page.documents ?? []) {
            if (!doc.name?.startsWith(`${root}/`)) throw new Error('Unexpected document name in Firestore response.');
            const path = doc.name.slice(root.length + 1);
            // Missing parents are returned only to permit traversal; they are not documents.
            if (doc.createTime) {
              if (++count > maxDocuments) throw new Error(`Document limit ${maxDocuments} exceeded; export is incomplete.`);
              counts[collection] = (counts[collection] ?? 0) + 1;
              await write(`${csv(path)},${csv(JSON.stringify(doc))}\n`);
            }
            await visit(doc.name);
          }
          documentToken = page.nextPageToken;
        } while (documentToken);
      }
      collectionToken = collections.nextPageToken;
    } while (collectionToken);
  }
  await visit(root);
  return { count, counts };
}
