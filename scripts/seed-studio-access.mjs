import { CognitoIdentityProviderClient, DescribeUserPoolCommand, ListUsersInGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import { cert, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { ROLE_TYPES, STUDIO_MODULES, rootPermissions } from '../src/lib/studio-policy.mjs';

const poolId = process.env.COGNITO_ADMIN_USER_POOL_ID || process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
for (const [key, value] of Object.entries({ poolId, FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY })) {
  if (!value) throw new Error(`Missing ${key}`);
}
const cognito = new CognitoIdentityProviderClient({ region: poolId.split('_')[0] });
try {
  const pool = (await cognito.send(new DescribeUserPoolCommand({ UserPoolId: poolId }))).UserPool;
  console.log(`Self-registration ${pool?.AdminCreateUserConfig?.AllowAdminCreateUserOnly ? 'disabled in Cognito; enable self-sign-up before launch' : 'enabled'}. No pool attributes will be changed.`);
} catch (error) {
  if (error.name !== 'AccessDeniedException') throw error;
  console.log('Self-registration setting could not be inspected with these AWS permissions. Seeding does not change the pool.');
}
const users = [];
let token;
do {
  const page = await cognito.send(new ListUsersInGroupCommand({ UserPoolId: poolId, GroupName: 'Admins', Limit: 60, NextToken: token }));
  users.push(...(page.Users ?? []));
  token = page.NextToken;
} while (token);
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ dryRun: true, modules: STUDIO_MODULES.map(module => module.id), roleTypes: ROLE_TYPES, root: 'root', existingGroupUsers: users.length }));
  process.exit(0);
}
const db = getFirestore(initializeApp({ credential: cert({ projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') }) }));
const seed = db.collection('studioSettings').doc('accessSeed');
await db.runTransaction(async tx => {
  const snapshot = await tx.get(seed);
  if (!snapshot.exists) tx.create(seed, { cutoff: new Date(), createdAt: FieldValue.serverTimestamp() });
});
const cutoff = (await seed.get()).data().cutoff.toDate();
const root = db.collection('studioRoles').doc('root');
await db.runTransaction(async tx => {
  const snapshot = await tx.get(root);
  tx.set(root, { name: 'Root', description: 'Full access to every studio module.', permissions: rootPermissions(), protected: true, ...(!snapshot.exists ? { userCount: 0, createdAt: FieldValue.serverTimestamp() } : {}) }, { merge: true });
});
for (const studioModule of STUDIO_MODULES) await db.collection('studioModules').doc(studioModule.id).set(studioModule);
for (const action of ROLE_TYPES) await db.collection('studioRoleTypes').doc(action).set({ id: action, key: `studio.actions.${action}` });
let seeded = 0;
for (const user of users) {
  if (user.UserCreateDate && user.UserCreateDate > cutoff) continue;
  const attributes = Object.fromEntries((user.Attributes ?? []).map(attribute => [attribute.Name, attribute.Value]));
  if (!attributes.sub || !user.Username) continue;
  const ref = db.collection('studioUsers').doc(attributes.sub);
  await db.runTransaction(async tx => {
    const existing = await tx.get(ref);
    if (existing.exists) return; // Preserve assigned roles and personal profiles on reruns.
    tx.create(ref, { sub: attributes.sub, username: user.Username, email: attributes.email ?? user.Username, firstName: attributes.given_name ?? '', lastName: attributes.family_name ?? '', displayName: attributes.name ?? attributes.email ?? user.Username, country: '', bio: '', roleId: 'root', enabled: Boolean(user.Enabled), createdAt: user.UserCreateDate ?? FieldValue.serverTimestamp(), seededAt: FieldValue.serverTimestamp() });
    if (user.Enabled) tx.update(root, { userCount: FieldValue.increment(1) });
    seeded++;
  });
}
console.log(JSON.stringify({ modules: STUDIO_MODULES.length, roleTypes: ROLE_TYPES.length, seededRootUsers: seeded }));
