import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withDevProfileDb } from './dev-content-db';
import { normalizeCreatorQuery } from './creator-search';
import { bestEffortDeleteProfileAvatar, profileAvatarUrl } from './profile-avatars';

type ProfileRow = { id: string; username: string | null; username_lower: string | null; birth_date: string | null; bio: string | null;
  avatar_type: string | null; avatar_id: string | null; avatar_key: string | null; created_at: Date | null; moderation_status?: string | null };
const columns = 'p.id,p.username,p.username_lower,p.birth_date::text,p.bio,p.avatar_type,p.avatar_id,p.avatar_key,p.created_at';
const fallbackName = (email: string) => email.split('@')[0] || 'Player';
async function lockProfile(db: PoolClient, id: string) { await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`profile:${id}`]); }
async function getRow(db: PoolClient, id: string) {
  return (await db.query<ProfileRow>(`SELECT ${columns},m.status AS moderation_status FROM app.player_profiles p LEFT JOIN app.avatar_moderation m ON m.player_id=p.id WHERE p.id=$1`, [id])).rows[0];
}
async function result(row: ProfileRow | undefined, fallback: string) {
  return { username: row?.username || fallbackName(fallback), birthDate: row?.birth_date ?? null, bio: row?.bio ?? '', avatarType: row?.avatar_type ?? null,
    avatarId: row?.avatar_id ?? null, avatarUrl: await profileAvatarUrl(row?.avatar_key ?? undefined), avatarRemoved: row?.moderation_status === 'removed' };
}
export async function getProfile(id: string, email: string) { return result(await withDevProfileDb(db => getRow(db, id)), email); }
export async function getProfilePublic(id: string) {
  const row = await withDevProfileDb(db => getRow(db, id));
  if (!row) return null;
  return { id, username: row.username ?? '', bio: row.bio ?? '', avatarUrl: await profileAvatarUrl(row.avatar_key ?? undefined), joinedAt: row.created_at?.toISOString() ?? null };
}
export async function getDisplayProfiles(ids: readonly string[], fallback: ReadonlyMap<string, string>) {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map<string, { username: string; avatarUrl: string | null }>();
  const rows = await withDevProfileDb(async db => (await db.query<ProfileRow>(`SELECT ${columns} FROM app.player_profiles p WHERE p.id=ANY($1)`, [unique])).rows);
  const byId = new Map(rows.map(row => [row.id, row]));
  return new Map(await Promise.all(unique.map(async id => {
    const row = byId.get(id);
    return [id, { username: row?.username || fallbackName(fallback.get(id) ?? ''), avatarUrl: await profileAvatarUrl(row?.avatar_key ?? undefined) }] as const;
  })));
}
export async function getExplicitProfiles(ids: string[]) {
  if (!ids.length) return [];
  return withDevProfileDb(async db => (await db.query<ProfileRow>(`SELECT ${columns} FROM app.player_profiles p WHERE p.id=ANY($1)`, [ids])).rows);
}
async function claimName(db: PoolClient, playerId: string, lower: string) {
  if ((await db.query('SELECT 1 FROM app.player_profiles WHERE username_lower=$1 AND id<>$2 LIMIT 1', [lower, playerId])).rowCount) return false;
  const inserted = await db.query('INSERT INTO app.username_claims (username_lower,player_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING player_id', [lower, playerId]);
  if (inserted.rowCount) return true;
  return Boolean((await db.query('SELECT 1 FROM app.username_claims WHERE username_lower=$1 AND player_id=$2', [lower, playerId])).rowCount);
}
export async function updateProfile(id: string, username: string, birthDate: string | null, bio: string | undefined, emailHash: string | null) {
  const lower = normalizeCreatorQuery(username);
  await withDevProfileDb(async db => {
    await lockProfile(db, id);
    const current = await getRow(db, id);
    if (!await claimName(db, id, lower)) throw new Error('USERNAME_TAKEN');
    await db.query(`INSERT INTO app.player_profiles (id,username,username_lower,birth_date,bio,email_search_hash,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,now()) ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username,username_lower=EXCLUDED.username_lower,
      birth_date=EXCLUDED.birth_date,bio=CASE WHEN $7::boolean THEN EXCLUDED.bio ELSE app.player_profiles.bio END,email_search_hash=EXCLUDED.email_search_hash,updated_at=now()`,
    [id, username, lower, birthDate, bio ?? null, emailHash, bio !== undefined]);
    const previous = current?.username ? normalizeCreatorQuery(current.username.replace(/\s+/g, ' ')) : '';
    if (previous && previous !== lower) await db.query('DELETE FROM app.username_claims WHERE username_lower=$1 AND player_id=$2', [previous, id]);
  });
  return { username, birthDate, ...(bio === undefined ? {} : { bio }) };
}
export async function initializeProfile(id: string, email: string, emailHash: string | null) {
  const row = await withDevProfileDb(async db => {
    await lockProfile(db, id);
    const current = await getRow(db, id);
    if (current?.username?.trim()) {
      await db.query('UPDATE app.player_profiles SET username_lower=$2,email_search_hash=$3 WHERE id=$1', [id, normalizeCreatorQuery(current.username), emailHash]);
      return getRow(db, id);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const username = `thughunter_${randomBytes(7).toString('hex').slice(0, 13)}`;
      if (!await claimName(db, id, username)) continue;
      await db.query(`INSERT INTO app.player_profiles (id,username,username_lower,email_search_hash,created_at,updated_at) VALUES ($1,$2,$2,$3,now(),now())
        ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username,username_lower=EXCLUDED.username_lower,email_search_hash=EXCLUDED.email_search_hash,
        created_at=coalesce(app.player_profiles.created_at,now()),updated_at=now()`, [id, username, emailHash]);
      return getRow(db, id);
    }
    throw new Error('Could not assign a unique username.');
  });
  return result(row, email);
}
export async function profileActivity(id: string) {
  await withDevProfileDb(db => db.query("UPDATE app.player_profiles SET last_active_at=now() WHERE id=$1 AND (last_active_at IS NULL OR last_active_at<=now()-interval '15 minutes')", [id]));
}
export async function searchProfiles(mode: 'username' | 'email', key: string, cursor: { name: string; id: string } | null, limit = 15) {
  return withDevProfileDb(async db => (await db.query<{ id: string; username_lower: string | null }>(mode === 'email'
    ? 'SELECT id,username_lower FROM app.player_profiles WHERE email_search_hash=$1 AND ($2::text IS NULL OR id COLLATE "C">$2 COLLATE "C") ORDER BY id COLLATE "C" LIMIT $3'
    : 'SELECT id,username_lower FROM app.player_profiles WHERE starts_with(username_lower,$1) AND ($2::text IS NULL OR (username_lower COLLATE "C",id COLLATE "C")>($2 COLLATE "C",$3 COLLATE "C")) ORDER BY username_lower COLLATE "C",id COLLATE "C" LIMIT $4',
  mode === 'email' ? [key, cursor?.id ?? null, limit + 1] : [key, cursor?.name ?? null, cursor?.id ?? null, limit + 1])).rows);
}
export async function choosePreset(playerId: string, avatarId: string | null) {
  const removed = await withDevProfileDb(async db => {
    await lockProfile(db, playerId);
    // Locking the preset serializes assignment against preset deletion.
    const preset = avatarId ? (await db.query<{ image_key: string | null }>('SELECT image_key FROM app.profile_avatars WHERE id=$1 FOR UPDATE', [avatarId])).rows[0] : null;
    if (avatarId && !preset?.image_key) throw new Error('That avatar is no longer available.');
    const previous = await getRow(db, playerId);
    const moderation = (await db.query<{ status: string | null; image_key: string | null }>('SELECT status,image_key FROM app.avatar_moderation WHERE player_id=$1', [playerId])).rows[0];
    const key = preset?.image_key ?? null;
    await db.query(`INSERT INTO app.player_profiles (id,avatar_type,avatar_id,avatar_key,updated_at) VALUES ($1,$2,$3,$4,now())
      ON CONFLICT (id) DO UPDATE SET avatar_type=EXCLUDED.avatar_type,avatar_id=EXCLUDED.avatar_id,avatar_key=EXCLUDED.avatar_key,updated_at=now()`, [playerId, avatarId ? 'preset' : null, avatarId, key]);
    if (moderation) await db.query("UPDATE app.avatar_moderation SET status='inactive',image_key=NULL,reviewed_at=now() WHERE player_id=$1", [playerId]);
    return [...new Set([previous?.avatar_type === 'custom' ? previous.avatar_key : null, moderation?.status === 'active' || moderation?.status === 'pending' ? moderation.image_key : null].filter((value): value is string => !!value && value !== key))];
  });
  await Promise.all(removed.map(bestEffortDeleteProfileAvatar));
}
export async function setCustomAvatar(playerId: string, email: string, key: string) {
  const old = await withDevProfileDb(async db => {
    await lockProfile(db, playerId);
    const previous = await getRow(db, playerId);
    await db.query(`INSERT INTO app.player_profiles (id,avatar_type,avatar_id,avatar_key,updated_at) VALUES ($1,'custom',NULL,$2,now())
      ON CONFLICT (id) DO UPDATE SET avatar_type='custom',avatar_id=NULL,avatar_key=EXCLUDED.avatar_key,updated_at=now()`, [playerId, key]);
    await db.query(`INSERT INTO app.avatar_moderation (player_id,username,image_key,status,updated_at) VALUES ($1,$2,$3,'active',now())
      ON CONFLICT (player_id) DO UPDATE SET username=EXCLUDED.username,image_key=EXCLUDED.image_key,status='active',updated_at=now()`, [playerId, previous?.username ?? fallbackName(email), key]);
    return previous?.avatar_type === 'custom' ? previous.avatar_key : null;
  });
  if (old && old !== key) await bestEffortDeleteProfileAvatar(old);
}
export async function listPresets(withCounts: boolean) {
  const rows = await withDevProfileDb(async db => (await db.query<{ id: string; name: string | null; image_key: string | null; users: number }>(
    `SELECT a.id,a.name,a.image_key,(SELECT count(*)::int FROM app.player_profiles p WHERE p.avatar_id=a.id) AS users FROM app.profile_avatars a ORDER BY a.created_at DESC NULLS LAST,a.id COLLATE "C"`)).rows);
  return Promise.all(rows.map(async row => ({ id: row.id, name: row.name ?? (withCounts ? '' : 'Dreamy avatar'), imageUrl: await profileAvatarUrl(row.image_key ?? undefined), ...(withCounts ? { userCount: row.users } : {}) })));
}
export async function addPreset(id: string, name: string, imageKey: string, contentType: string) {
  await withDevProfileDb(db => db.query('INSERT INTO app.profile_avatars (id,name,image_key,content_type,created_at) VALUES ($1,$2,$3,$4,now())', [id, name, imageKey, contentType]));
}
export async function deletePreset(id: string) {
  const key = await withDevProfileDb(async db => {
    const preset = (await db.query<{ image_key: string | null }>('SELECT image_key FROM app.profile_avatars WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!preset) throw Object.assign(new Error('Avatar preset not found.'), { status: 404 });
    if ((await db.query('SELECT 1 FROM app.player_profiles WHERE avatar_id=$1 LIMIT 1', [id])).rowCount) throw Object.assign(new Error('This avatar is in use and cannot be deleted.'), { status: 409 });
    await db.query('DELETE FROM app.profile_avatars WHERE id=$1', [id]); return preset.image_key;
  });
  await bestEffortDeleteProfileAvatar(key ?? undefined);
}
export async function listCustomAvatars() {
  const rows = await withDevProfileDb(async db => (await db.query<ProfileRow>(`SELECT ${columns} FROM app.player_profiles p WHERE p.avatar_type='custom' AND p.avatar_key IS NOT NULL ORDER BY p.id COLLATE "C"`)).rows);
  return Promise.all(rows.map(async row => ({ userId: row.id, username: row.username ?? row.id, imageUrl: await profileAvatarUrl(row.avatar_key ?? undefined) })));
}
export async function removeCustomAvatar(id: string) {
  const key = await withDevProfileDb(async db => {
    await lockProfile(db, id);
    const row = await getRow(db, id);
    if (row?.avatar_type !== 'custom' || !row.avatar_key) throw new Error('This player does not have a custom avatar in use.');
    await db.query('UPDATE app.player_profiles SET avatar_type=NULL,avatar_id=NULL,avatar_key=NULL,updated_at=now() WHERE id=$1', [id]);
    await db.query(`INSERT INTO app.avatar_moderation (player_id,status,image_key,reviewed_at) VALUES ($1,'removed',NULL,now())
      ON CONFLICT (player_id) DO UPDATE SET status='removed',image_key=NULL,reviewed_at=now()`, [id]);
    return row.avatar_key;
  });
  await bestEffortDeleteProfileAvatar(key);
}
export async function dashboardCounts() {
  return withDevProfileDb(async db => (await db.query(`SELECT count(*)::int AS registered,count(*) FILTER (WHERE created_at>=now()-interval '7 days')::int AS "newProfiles",
    count(*) FILTER (WHERE last_active_at>=now()-interval '1 day')::int AS "activeDay",count(*) FILTER (WHERE last_active_at>=now()-interval '7 days')::int AS "activeWeek",
    count(*) FILTER (WHERE last_active_at>=now()-interval '30 days')::int AS "activeMonth" FROM app.player_profiles`)).rows[0]);
}
