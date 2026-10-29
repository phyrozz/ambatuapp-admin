import { cert } from 'firebase-admin/app';
import { open, link, unlink, lstat } from 'node:fs/promises';
import { exportFirestore } from './firestore-export-core.mjs';

async function main() {
  const [output, maximum, database = '(default)'] = process.argv.slice(2);
  const maxDocuments = Number(maximum);
  if (!output || !Number.isSafeInteger(maxDocuments) || maxDocuments < 1 || process.argv.length > 5) {
    throw new Error('Usage: node --env-file=.env.local scripts/export-firestore-full.mjs OUTPUT.csv MAX_DOCUMENTS [DATABASE_ID]');
  }
  const { FIREBASE_PROJECT_ID: project, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (!project || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) throw new Error('Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.');
  const credential = cert({ projectId: project, clientEmail: FIREBASE_CLIENT_EMAIL, privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') });
  const partial = `${output}.partial`;
  try { await lstat(output); throw new Error('Output file already exists.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const file = await open(partial, 'wx');
  let closed = false;
  try {
    const result = await exportFirestore({ project, database, maxDocuments,
      async request(path, options = {}) {
        const token = await credential.getAccessToken();
        const response = await fetch(`https://firestore.googleapis.com${path}`, {
          method: options.method ?? 'GET',
          headers: { Authorization: `Bearer ${token.access_token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        });
        if (!response.ok) throw new Error(`Firestore request failed (HTTP ${response.status}): ${(await response.text()).slice(0, 1000)}`);
        return response.json();
      },
      async write(line) { await file.writeFile(line); },
    });
    await file.close();
    closed = true;
    // Hard-link creation fails rather than overwriting an existing final export.
    await link(partial, output);
    await unlink(partial);
    console.log(`Completed export: ${result.count} documents. Counts by collection ID: ${JSON.stringify(result.counts)}`);
  } finally {
    if (!closed) await file.close();
  }
}

main().catch(error => { console.error(`${error.message}\nExport did not complete; any .partial file must not be imported.`); process.exitCode = 1; });
