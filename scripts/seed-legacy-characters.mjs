import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const characters = [
  ['dreamybullxxx', 'DreamybullXXX', 'dreamy.jpg'], ['amkaming', 'Amkaming', 'ankaming.jpg'], ['daddy-amkaming', 'Daddy Amkaming', 'daddy_amkaming.jpg'], ['viktor', 'Viktor', 'viktor.jpg'], ['bunda-rahma', 'Bunda Rahma', 'bunda.jpg'], ['kakangku', 'Kakangku', 'kakangku.jpg'], ['nissan', 'Nissan', 'nissan.jpg'], ['brandon-currington', 'Brandon Currington', 'hump_day.jpg'], ['ampassing', 'Ampassing', 'ampassing.jpg'], ['yes-king', 'Yes King', 'yes_king.jpg'], ['turbulence-man', 'Turbulence Man', 'turbulence_man.jpg'], ['axel', 'Axel', 'axel.jpg'], ['bus-soldier', 'Bus Soldier', 'bus_soldier.png']
];
const required = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'NEXT_PUBLIC_AWS_REGION', 'AWS_S3_CHARACTER_IMAGES_BUCKET'];
const missing = required.filter(key => !process.env[key]);
if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = getApps()[0] ?? initializeApp({ credential: cert({ projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') }) });
const db = getFirestore(app);
const s3 = new S3Client({ region: process.env.NEXT_PUBLIC_AWS_REGION });
for (const [id, name, filename] of characters) {
  const body = await readFile(path.join(root, 'legacy', 'assets', filename));
  const imageKey = `characters/${id}/portrait.${path.extname(filename).slice(1)}`;
  await s3.send(new PutObjectCommand({ Bucket: process.env.AWS_S3_CHARACTER_IMAGES_BUCKET, Key: imageKey, Body: body, ContentType: filename.endsWith('.png') ? 'image/png' : 'image/jpeg' }));
  await db.collection('characters').doc(id).set({ name, title: 'Legacy Ambaverse character', bio: 'Imported from the legacy Ambatuapp character collection.', status: 'Published', tags: ['Legacy'], imageKey, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), updated: 'Seeded from legacy' }, { merge: true });
  console.log(`Seeded ${name}`);
}
console.log(`Done — seeded ${characters.length} legacy characters.`);
