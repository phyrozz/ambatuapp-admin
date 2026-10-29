// A bounded, read-only pilot export of one top-level collection.
import { cert, initializeApp } from 'firebase-admin/app';
import { FieldPath, GeoPoint, Timestamp, DocumentReference, getFirestore } from 'firebase-admin/firestore';
import { writeFile } from 'node:fs/promises';

function encode(value) {
  if (value instanceof Timestamp) return { type: 'timestamp', seconds: String(value.seconds), nanoseconds: value.nanoseconds };
  if (value instanceof GeoPoint) return { type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  if (value instanceof DocumentReference) return { type: 'reference', path: value.path };
  if (Buffer.isBuffer(value)) return { type: 'bytes', base64: value.toString('base64') };
  if (value === null) return { type: 'null' };
  if (typeof value === 'number') {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error('Unsafe integer encountered; use a lossless exporter for this collection.');
    return { type: 'number', value: Number.isFinite(value) ? value : String(value) };
  }
  if (typeof value === 'string' || typeof value === 'boolean') return { type: typeof value, value };
  if (Array.isArray(value)) return { type: 'array', value: value.map(encode) };
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return { type: 'map', value: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)])) };
  }
  throw new Error(`Unsupported Firestore value: ${Object.prototype.toString.call(value)}`);
}

function csv(value) { return `"${value.replaceAll('"', '""')}"`; }

async function main() {
  const [collection, output, maximum] = process.argv.slice(2);
  const limit = Number(maximum);
  if (!collection || collection.includes('/') || !output || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Usage: node --env-file=.env.local scripts/export-firestore-pilot.mjs COLLECTION OUTPUT.csv LIMIT (1–100)');
  }
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) throw new Error('Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.');
  const app = initializeApp({ credential: cert({ projectId: FIREBASE_PROJECT_ID, clientEmail: FIREBASE_CLIENT_EMAIL, privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') }) });
  const snapshot = await getFirestore(app).collection(collection).orderBy(FieldPath.documentId()).limit(limit).get();
  const rows = snapshot.docs.map(doc => `${csv(doc.ref.path)},${csv(JSON.stringify(encode(doc.data())))}`);
  await writeFile(output, `path,data\n${rows.join('\n')}${rows.length ? '\n' : ''}`, { flag: 'wx' });
  console.log(`Exported ${rows.length} documents from ${collection} to ${output}. Subcollections were not exported.`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
