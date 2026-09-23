import { cert, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';

const required = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
if (required.some(key => !process.env[key])) throw new Error('Firebase credentials are required.');
initializeApp({ credential: cert({ projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') }) });
const db = getFirestore();
let cursor;
let updated = 0;
for (;;) {
  let query = db.collection('playerProfiles').orderBy(FieldPath.documentId()).limit(400);
  if (cursor) query = query.startAfter(cursor);
  const page = await query.get();
  if (page.empty) break;
  const batch = db.batch();
  for (const doc of page.docs) {
    const username = doc.data().username;
    if (typeof username === 'string' && doc.data().usernameLower !== username.toLocaleLowerCase()) {
      batch.update(doc.ref, { usernameLower: username.toLocaleLowerCase() });
      updated++;
    }
  }
  await batch.commit();
  cursor = page.docs.at(-1);
}
console.log(`Updated ${updated} player profiles for username search.`);
