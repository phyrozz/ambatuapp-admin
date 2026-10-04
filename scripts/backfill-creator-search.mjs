// Populate exact-email search for existing profiles without exposing raw email in the API.
import { createHash } from 'node:crypto';
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { cert, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const required = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'COGNITO_PLAYER_USER_POOL_ID'];
if (required.some(key => !process.env[key])) throw new Error('Firebase credentials and the player pool ID are required.');
const pool = process.env.COGNITO_PLAYER_USER_POOL_ID;
const dryRun = process.argv.includes('--dry-run');
initializeApp({ credential: cert({ projectId:process.env.FIREBASE_PROJECT_ID, clientEmail:process.env.FIREBASE_CLIENT_EMAIL, privateKey:process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') }) });
const db = getFirestore();
const cognito = new CognitoIdentityProviderClient({ region:pool.split('_')[0] });
let token, updated = 0;
do {
  const page = await cognito.send(new ListUsersCommand({ UserPoolId:pool, Limit:60, ...(token ? { PaginationToken:token } : {}) }));
  const users = (page.Users ?? []).map(user => Object.fromEntries((user.Attributes ?? []).map(attr => [attr.Name, attr.Value]))).filter(user => user.sub);
  const docs = users.length ? await db.getAll(...users.map(user => db.collection('playerProfiles').doc(user.sub))) : [];
  const batch = db.batch();
  for (const [i, doc] of docs.entries()) {
    if (!doc.exists) continue;
    const user = users[i];
    const hash = user.email_verified === 'true' && user.email ? createHash('sha256').update(user.email.normalize('NFKC').trim().toLocaleLowerCase()).digest('hex') : null;
    const username = doc.data().username;
    const lower = typeof username === 'string' ? username.normalize('NFKC').trim().toLocaleLowerCase() : null;
    if ((doc.data().emailSearchHash ?? null) === hash && (!lower || lower === doc.data().usernameLower)) continue;
    batch.update(doc.ref, { emailSearchHash:hash ?? FieldValue.delete(), ...(lower ? { usernameLower:lower } : {}) });
    updated++;
  }
  if (!dryRun) await batch.commit();
  token = page.PaginationToken;
} while (token);
console.log(`${dryRun ? 'Would update' : 'Updated'} ${updated} existing creator search profiles.`);
