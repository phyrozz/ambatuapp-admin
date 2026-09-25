import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const required = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'NEXT_PUBLIC_AWS_REGION', 'AWS_S3_CHARACTER_IMAGES_BUCKET'];
const missing = required.filter(key => !process.env[key]);
if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const legacy = JSON.parse(await readFile(path.join(root, 'revamp', 'src', 'data', 'legacy.json'), 'utf8'));
const app = getApps()[0] ?? initializeApp({ credential: cert({
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
}) });
const db = getFirestore(app);
const s3 = new S3Client({ region: process.env.NEXT_PUBLIC_AWS_REGION });
let added = 0;
let skipped = 0;

for (const sound of legacy.sounds) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sound.id) || !sound.file?.startsWith('/assets/sounds/')) {
    throw new Error(`Invalid legacy sound entry: ${sound.id}`);
  }
  const ref = db.collection('soundboardSounds').doc(sound.id);
  if ((await ref.get()).exists) {
    skipped += 1;
    continue;
  }
  const localFile = path.resolve(root, 'revamp', 'public', sound.file.slice(1));
  const expectedRoot = path.resolve(root, 'revamp', 'public', 'assets', 'sounds') + path.sep;
  if (!localFile.startsWith(expectedRoot)) throw new Error(`Sound file is outside the legacy audio folder: ${sound.file}`);
  const body = await readFile(localFile);
  const soundKey = `soundboard/legacy/${sound.id}.mp3`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.AWS_S3_CHARACTER_IMAGES_BUCKET,
    Key: soundKey,
    Body: body,
    ContentType: 'audio/mpeg',
  }));
  await ref.set({
    name: sound.name,
    category: sound.category,
    color: Number.isInteger(sound.color) ? Math.min(3, Math.max(0, sound.color)) : added % 4,
    soundKey,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  added += 1;
  console.log(`Added ${sound.name}`);
}

console.log(`Finished. Added ${added} sounds; left ${skipped} existing entries unchanged.`);
