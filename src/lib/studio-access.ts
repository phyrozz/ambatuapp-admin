import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './firebase-admin';
import { normalizePermissions, type StudioRole, type StudioUser } from './studio-policy.mjs';

export function studioDb() {
  if (!adminDb) throw new Error('studio.errors.firestore');
  return adminDb;
}
export async function getStudioAccess(sub: string) {
  const db = studioDb();
  const profile = (await db.collection('studioUsers').doc(sub).get()).data();
  if (!profile || profile.enabled !== true || profile.registrationPending === true) throw new Error('studio.errors.forbidden');
  const role = typeof profile.roleId === 'string' ? (await db.collection('studioRoles').doc(profile.roleId).get()).data() : null;
  return { profile: { ...profile, sub } as StudioUser, roleId: profile.roleId ?? null, roleName: role?.name ?? null, permissions: role ? normalizePermissions(role.permissions) : {} };
}
export function validId(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('studio.errors.invalidId');
  return value;
}
export async function findStudioRoleId(name: string) {
  const snapshot = await studioDb().collection('studioRoles').where('name', '==', name).limit(1).get();
  const role = snapshot.docs[0];
  if (!role) throw new Error('studio.errors.roleMissing');
  return role.id;
}
export async function completeStudioRegistration(sub: string, roleId: string) {
  const db = studioDb(), userRef = db.collection('studioUsers').doc(validId(sub));
  const newRoleId = validId(roleId);
  await db.runTransaction(async tx => {
    const user = await tx.get(userRef), profile = user.data();
    if (!user.exists || profile?.enabled !== true) throw new Error('studio.errors.forbidden');
    if (profile.registrationPending !== true) return;
    const oldRoleId = typeof profile.roleId === 'string' ? validId(profile.roleId) : null;
    const roleIds = [...new Set([oldRoleId, newRoleId].filter((id): id is string => Boolean(id)))];
    const roles = await Promise.all(roleIds.map(id => tx.get(db.collection('studioRoles').doc(id))));
    const newRole = roles.find(role => role.id === newRoleId);
    if (!newRole?.exists || newRole.data()?.name !== 'Creator') throw new Error('studio.errors.roleMissing');
    if (oldRoleId !== newRoleId) {
      for (const role of roles) {
        if (role.exists) tx.update(role.ref, { userCount: FieldValue.increment(role.id === newRoleId ? 1 : -1) });
      }
    }
    tx.update(userRef, { roleId: newRoleId, registrationPending: false, updatedAt: FieldValue.serverTimestamp() });
  });
}
export async function listStudioRecords(collection: 'studioUsers' | 'studioRoles', cursor: string | null) {
  const db = studioDb();
  let query = db.collection(collection).orderBy(FieldPath.documentId()).limit(31);
  if (cursor) query = query.startAfter(validId(cursor));
  const snapshot = await query.get();
  const docs = snapshot.docs.slice(0, 30);
  const roleIds = collection === 'studioUsers' ? [...new Set(docs.map(doc => doc.data().roleId).filter((id): id is string => typeof id === 'string'))] : [];
  const roles = roleIds.length ? await db.getAll(...roleIds.map(id => db.collection('studioRoles').doc(id))) : [];
  const roleNames = new Map(roles.map(role => [role.id, role.data()?.name]));
  return {
    items: docs.map(doc => {
      const data = doc.data();
      return { ...data, id: doc.id, sub: collection === 'studioUsers' ? doc.id : undefined, roleName: roleNames.get(data.roleId) ?? null, createdAt: data.createdAt?.toDate?.().toISOString() ?? null };
    }),
    nextCursor: snapshot.docs.length > 30 ? docs.at(-1)!.id : null,
  };
}
export async function saveRole(body: Record<string, unknown>, id?: string) {
  const db = studioDb();
  if (id === 'root') throw new Error('studio.errors.rootProtected');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!name || name.length > 80 || description.length > 500) throw new Error('studio.errors.roleName');
  const permissions = normalizePermissions(body.permissions);
  const ref = id ? db.collection('studioRoles').doc(validId(id)) : db.collection('studioRoles').doc();
  await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    if (id && !snapshot.exists) throw new Error('studio.errors.roleMissing');
    tx.set(ref, { name, description, permissions, protected: false, updatedAt: FieldValue.serverTimestamp(), ...(!id ? { userCount: 0, createdAt: FieldValue.serverTimestamp() } : {}) }, { merge: true });
  });
  return { id: ref.id, name, description, permissions };
}
export async function deleteRole(id: string) {
  if (id === 'root') throw new Error('studio.errors.rootProtected');
  const db = studioDb(), ref = db.collection('studioRoles').doc(validId(id));
  await db.runTransaction(async tx => {
    const role = await tx.get(ref);
    if (!role.exists) throw new Error('studio.errors.roleMissing');
    if ((role.data()?.userCount ?? 0) > 0) throw new Error('studio.errors.roleInUse');
    tx.delete(ref);
  });
}
// Counts and assignments share a transaction so assigned roles cannot be deleted.
export async function saveStudioUser(sub: string, patch: Partial<StudioUser>, actor?: { sub: string; roleId: string | null }, creating = false) {
  const db = studioDb(), ref = db.collection('studioUsers').doc(validId(sub));
  await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref), prior = snapshot.data();
    if (creating && snapshot.exists) throw new Error('studio.errors.userExists');
    if (!creating && !snapshot.exists) throw new Error('studio.errors.userMissing');
    const oldRole = prior?.enabled ? prior.roleId ?? null : null;
    const enabled = patch.enabled ?? prior?.enabled ?? true;
    const newRole = enabled ? patch.roleId === undefined ? prior?.roleId ?? null : patch.roleId : null;
    if (prior?.registrationPending === true && newRole) throw new Error('studio.errors.registrationPending');
    if (actor && (oldRole === 'root' || newRole === 'root') && actor.roleId !== 'root') throw new Error('studio.errors.rootAssignment');
    if (actor?.sub === sub && (newRole !== oldRole || !enabled)) throw new Error('studio.errors.selfChange');
    const roleIds = [...new Set([oldRole, newRole].filter((id): id is string => Boolean(id)))];
    const roles = await Promise.all(roleIds.map(id => tx.get(db.collection('studioRoles').doc(validId(id)))));
    if (newRole && !roles.find(role => role.id === newRole)?.exists) throw new Error('studio.errors.roleMissing');
    if (oldRole === 'root' && newRole !== 'root' && (roles.find(role => role.id === 'root')?.data()?.userCount ?? 0) <= 1) throw new Error('studio.errors.lastRoot');
    if (oldRole !== newRole) for (const role of roles) {
      if (role.exists) tx.update(role.ref, { userCount: FieldValue.increment(role.id === newRole ? 1 : -1) });
    }
    tx.set(ref, { ...patch, roleId: enabled ? newRole : null, enabled, updatedAt: FieldValue.serverTimestamp(), ...(creating ? { createdAt: FieldValue.serverTimestamp() } : {}) }, { merge: true });
  });
}
export type { StudioRole, StudioUser };
