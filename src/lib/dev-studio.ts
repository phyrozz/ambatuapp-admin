import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withDevStudioDb } from './dev-content-db';
import { normalizePermissions, rootPermissions, type StudioUser } from './studio-policy.mjs';

type UserRow = { id: string; first_name: string | null; last_name: string | null; display_name: string | null; country: string | null; bio: string | null;
  email: string | null; username: string | null; role_id: string | null; enabled: boolean; registration_pending: boolean; created_at: Date | null; extra: Record<string, unknown> };
type RoleRow = { id: string; name: string; description: string | null; protected: boolean; created_at: Date | null; extra: Record<string, unknown>; user_count: number; permissions: Record<string, string[]> };
function validId(id: string) { if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('studio.errors.invalidId'); return id; }
async function lockStudio(db: PoolClient) { await db.query("SELECT pg_advisory_xact_lock(hashtextextended('ambatu-dev-studio-access',0))"); }
function user(row: UserRow) {
  return { ...row.extra, sub: row.id, firstName: row.first_name ?? '', lastName: row.last_name ?? '', displayName: row.display_name ?? '', country: row.country ?? '', bio: row.bio ?? '',
    email: row.email ?? '', username: row.username ?? '', roleId: row.role_id, enabled: row.enabled, registrationPending: row.registration_pending, createdAt: row.created_at?.toISOString() ?? null } as StudioUser;
}
const roleSelect = `SELECT r.id,r.name,r.description,r.protected,r.created_at,r.extra,
  (SELECT count(*)::int FROM app.studio_users u WHERE u.role_id=r.id AND u.enabled) AS user_count,
  coalesce((SELECT jsonb_object_agg(p.module_id,p.actions) FROM (SELECT module_id,jsonb_agg(action_id ORDER BY action_id) AS actions FROM app.studio_role_permissions WHERE role_id=r.id GROUP BY module_id) p),'{}'::jsonb) AS permissions
  FROM app.studio_roles r`;
async function role(db: PoolClient, id: string) { return (await db.query<RoleRow>(`${roleSelect} WHERE r.id=$1`, [id])).rows[0]; }
function roleOutput(row: RoleRow) { return { ...row.extra, id: row.id, name: row.name, description: row.description ?? '', protected: row.protected,
  userCount: row.user_count, permissions: normalizePermissions(row.permissions), createdAt: row.created_at?.toISOString() ?? null, roleName: null }; }
export async function getStudioUser(sub: string) {
  const row = await withDevStudioDb(async db => (await db.query<UserRow>('SELECT * FROM app.studio_users WHERE id=$1', [validId(sub)])).rows[0]);
  return row ? user(row) : undefined;
}
export async function studioRoleExists(id: string) {
  return withDevStudioDb(async db => Boolean((await db.query('SELECT 1 FROM app.studio_roles WHERE id=$1', [validId(id)])).rowCount));
}
export async function getAccess(sub: string) {
  return withDevStudioDb(async db => {
    const row = (await db.query<UserRow>('SELECT * FROM app.studio_users WHERE id=$1', [validId(sub)])).rows[0];
    if (!row || !row.enabled || row.registration_pending) throw new Error('studio.errors.forbidden');
    const selected = row.role_id ? await role(db, row.role_id) : undefined;
    return { profile: user(row), roleId: row.role_id, roleName: selected?.name ?? null,
      permissions: selected ? row.role_id === 'root' ? rootPermissions() : normalizePermissions(selected.permissions) : {} };
  });
}
export async function findRole(name: string) {
  const row = await withDevStudioDb(async db => (await db.query<{ id: string }>('SELECT id FROM app.studio_roles WHERE name=$1 ORDER BY id COLLATE "C" LIMIT 1', [name])).rows[0]);
  if (!row) throw new Error('studio.errors.roleMissing'); return row.id;
}
export async function completeRegistration(sub: string, roleId: string) {
  await withDevStudioDb(async db => {
    await lockStudio(db);
    const row = (await db.query<UserRow>('SELECT * FROM app.studio_users WHERE id=$1 FOR UPDATE', [validId(sub)])).rows[0];
    if (!row || !row.enabled) throw new Error('studio.errors.forbidden');
    if (!row.registration_pending) return;
    const next = await role(db, validId(roleId));
    if (!next || next.name !== 'Creator') throw new Error('studio.errors.roleMissing');
    await db.query('UPDATE app.studio_users SET role_id=$2,registration_pending=false,updated_at=now() WHERE id=$1', [sub, roleId]);
  });
}
export async function listRecords(collection: 'studioUsers' | 'studioRoles', cursor: string | null) {
  const after = cursor ? validId(cursor) : null;
  return withDevStudioDb(async db => {
    if (collection === 'studioRoles') {
      const rows = (await db.query<RoleRow>(`${roleSelect} WHERE ($1::text IS NULL OR r.id COLLATE "C">$1 COLLATE "C") ORDER BY r.id COLLATE "C" LIMIT 31`, [after])).rows;
      const page = rows.slice(0, 30); return { items: page.map(roleOutput), nextCursor: rows.length > 30 ? page.at(-1)!.id : null };
    }
    const rows = (await db.query<UserRow & { role_name: string | null }>(`SELECT u.*,r.name AS role_name FROM app.studio_users u LEFT JOIN app.studio_roles r ON r.id=u.role_id
      WHERE ($1::text IS NULL OR u.id COLLATE "C">$1 COLLATE "C") ORDER BY u.id COLLATE "C" LIMIT 31`, [after])).rows;
    const page = rows.slice(0, 30); return { items: page.map(row => ({ ...user(row), id: row.id, roleName: row.role_name })), nextCursor: rows.length > 30 ? page.at(-1)!.id : null };
  });
}
export async function saveRoleDb(body: Record<string, unknown>, id?: string) {
  if (id === 'root') throw new Error('studio.errors.rootProtected');
  const name = typeof body.name === 'string' ? body.name.trim() : '', description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!name || name.length > 80 || description.length > 500) throw new Error('studio.errors.roleName');
  const permissions = normalizePermissions(body.permissions), roleId = id ? validId(id) : randomUUID();
  await withDevStudioDb(async db => {
    await lockStudio(db);
    if (id && !await role(db, roleId)) throw new Error('studio.errors.roleMissing');
    await db.query(`INSERT INTO app.studio_roles (id,name,description,protected,created_at,updated_at) VALUES ($1,$2,$3,false,now(),now())
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,protected=false,updated_at=now()`, [roleId, name, description]);
    await db.query('DELETE FROM app.studio_role_permissions WHERE role_id=$1', [roleId]);
    for (const [moduleId, actions] of Object.entries(permissions)) for (const action of actions ?? [])
      await db.query('INSERT INTO app.studio_role_permissions (role_id,module_id,action_id) VALUES ($1,$2,$3)', [roleId, moduleId, action]);
  });
  return { id: roleId, name, description, permissions };
}
export async function deleteRoleDb(id: string) {
  if (id === 'root') throw new Error('studio.errors.rootProtected');
  await withDevStudioDb(async db => {
    await lockStudio(db);
    const existing = await role(db, validId(id));
    if (!existing) throw new Error('studio.errors.roleMissing');
    // Disabled users can retain legacy role references; clear those before deleting the role.
    if (existing.user_count > 0) throw new Error('studio.errors.roleInUse');
    await db.query('UPDATE app.studio_users SET role_id=NULL WHERE role_id=$1 AND NOT enabled', [id]);
    await db.query('DELETE FROM app.studio_roles WHERE id=$1', [id]);
  });
}
export async function saveUserDb(sub: string, patch: Partial<StudioUser>, actor?: { sub: string; roleId: string | null }, creating = false) {
  await withDevStudioDb(async db => {
    await lockStudio(db);
    const prior = (await db.query<UserRow>('SELECT * FROM app.studio_users WHERE id=$1 FOR UPDATE', [validId(sub)])).rows[0];
    if (creating && prior) throw new Error('studio.errors.userExists');
    if (!creating && !prior) throw new Error('studio.errors.userMissing');
    const oldRole = prior?.enabled ? prior.role_id : null, enabled = patch.enabled ?? prior?.enabled ?? true;
    const nextRole = enabled ? patch.roleId === undefined ? prior?.role_id ?? null : patch.roleId : null;
    if (prior?.registration_pending && nextRole) throw new Error('studio.errors.registrationPending');
    if (actor && (oldRole === 'root' || nextRole === 'root') && actor.roleId !== 'root') throw new Error('studio.errors.rootAssignment');
    if (actor?.sub === sub && (nextRole !== oldRole || !enabled)) throw new Error('studio.errors.selfChange');
    if (nextRole && !await role(db, validId(nextRole))) throw new Error('studio.errors.roleMissing');
    if (oldRole === 'root' && nextRole !== 'root' && ((await role(db, 'root'))?.user_count ?? 0) <= 1) throw new Error('studio.errors.lastRoot');
    await db.query(`INSERT INTO app.studio_users (id,first_name,last_name,display_name,country,bio,email,username,role_id,enabled,registration_pending,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now()) ON CONFLICT (id) DO UPDATE SET first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,
      display_name=EXCLUDED.display_name,country=EXCLUDED.country,bio=EXCLUDED.bio,email=EXCLUDED.email,username=EXCLUDED.username,role_id=EXCLUDED.role_id,
      enabled=EXCLUDED.enabled,registration_pending=EXCLUDED.registration_pending,updated_at=now()`,
    [sub, patch.firstName ?? prior?.first_name ?? null, patch.lastName ?? prior?.last_name ?? null, patch.displayName ?? prior?.display_name ?? null,
      patch.country ?? prior?.country ?? null, patch.bio ?? prior?.bio ?? null, patch.email ?? prior?.email ?? null, patch.username ?? prior?.username ?? null,
      nextRole, enabled, patch.registrationPending ?? prior?.registration_pending ?? false]);
  });
}
