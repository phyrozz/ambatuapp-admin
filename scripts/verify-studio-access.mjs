import assert from 'node:assert/strict';
import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { ROLE_TYPES, STUDIO_MODULES, rootPermissions } from '../src/lib/studio-policy.mjs';
const credential = cert({ projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') });
const db = getFirestore(initializeApp({ credential }));
const [role, users, modules, types] = await Promise.all([db.collection('studioRoles').doc('root').get(), db.collection('studioUsers').where('roleId', '==', 'root').get(), db.collection('studioModules').get(), db.collection('studioRoleTypes').get()]);
assert.equal(role.data().protected, true);
assert.deepEqual(role.data().permissions, rootPermissions());
assert.equal(role.data().userCount, users.docs.filter(doc => doc.data().enabled).length);
assert.deepEqual(modules.docs.map(doc => doc.id).sort(), STUDIO_MODULES.map(item => item.id).sort());
assert.deepEqual(types.docs.map(doc => doc.id).sort(), [...ROLE_TYPES].sort());
console.log(JSON.stringify({ modulesVerified: modules.size, typesVerified: types.size, rootUsers: users.size, activeRootUsers: role.data().userCount }));
if (process.argv.includes('--inspect-rules')) {
  const token = (await credential.getAccessToken()).access_token;
  const headers = { authorization: `Bearer ${token}` };
  const release = await fetch(`https://firebaserules.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/releases/cloud.firestore`, { headers });
  if (!release.ok) { console.log(`Rules inspection returned HTTP ${release.status}.`); process.exit(0); }
  const rulesetName = (await release.json()).rulesetName;
  const rules = await fetch(`https://firebaserules.googleapis.com/v1/${rulesetName}`, { headers });
  if (!rules.ok) throw new Error(`Rules inspection returned HTTP ${rules.status}.`);
  for (const file of (await rules.json()).source.files) console.log(file.content);
}
