import { randomUUID } from 'node:crypto';
import { ContributionError } from './community-content';
import { soundAudioUrl, soundColor, type SoundFields } from './admin-sounds';
import { adminSoundUploadKey, deleteSoundUpload, signedSoundUrl, validSoundAssetKey, verifySoundUpload } from './s3-sounds';
import { isStudioRoot, type StudioContentActor } from './studio-content';
import { characterListFilter, encodeCharacterListCursor, parseCharacterListCursor } from './character-list-pagination';
import { withDevSoundDb } from './dev-content-db';

type Row = { id: string; status: string | null; status_missing: boolean; source: string | null; uploader_id: string | null; created_by: string | null;
  created_at: Date | null; cursor_time: string; name: string | null; category: string | null; color: number | null; sound_key: string | null; play_count: string; listener_count: string };
const time = "coalesce(c.created_at, '1970-01-01T00:00:00Z'::timestamptz)";
const select = `SELECT c.id,c.status,c.status_missing,c.source,c.uploader_id,c.created_by,c.created_at,
  to_char(${time} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,
  s.name,s.category,s.color,s.sound_key,s.play_count,s.listener_count FROM app.content c JOIN app.sounds s ON s.id=c.id AND s.kind=c.kind`;
function count(value: string) { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid sound counter'); return n; }
function publicSound(row: Row) { return (row.status === 'Published' || row.status_missing) && validSoundAssetKey(row.sound_key) && typeof row.name === 'string' && typeof row.category === 'string'; }
function cursorId(raw: string | null) {
  if (!raw) return null;
  const id = Buffer.from(raw, 'base64url').toString('utf8');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) throw new ContributionError(400);
  return id;
}
export async function listCreatorSounds(playerId: string, url: URL) {
  const requested = Number(url.searchParams.get('limit')) || 20;
  const limit = Math.min(50, Math.max(1, Math.floor(Number.isFinite(requested) ? requested : 20)));
  const id = cursorId(url.searchParams.get('cursor'));
  const rows = await withDevSoundDb(async db => {
    const cursor = id ? (await db.query<Row>(`${select} WHERE c.kind='sound' AND c.id=$1 AND c.uploader_id=$2 AND c.source='revamp'`, [id, playerId])).rows[0] : null;
    if (id && !cursor) throw new ContributionError(400);
    return (await db.query<Row>(`${select} WHERE c.kind='sound' AND c.uploader_id=$1 AND c.source='revamp'
      AND ($2::timestamptz IS NULL OR (${time},c.id COLLATE "C")<($2::timestamptz,$3 COLLATE "C"))
      ORDER BY ${time} DESC,c.id COLLATE "C" DESC LIMIT $4`, [playerId, cursor?.cursor_time ?? null, cursor?.id ?? null, limit + 1])).rows;
  });
  const page = rows.slice(0, limit), last = page.at(-1);
  const sounds = (await Promise.all(page.map(async row => {
    try {
      const key = adminSoundUploadKey(row.sound_key, `player_${playerId}`);
      if (typeof row.name !== 'string' || typeof row.category !== 'string') return null;
      return { id: row.id, status: row.status === 'Draft' ? 'Draft' : 'Published', name: row.name, category: row.category,
        playCount: count(row.play_count), listenerCount: count(row.listener_count), file: row.status === 'Draft' ? await signedSoundUrl(key) : soundAudioUrl(url.origin, row.id), createdAt: row.created_at?.toISOString() ?? null };
    } catch { return null; }
  }))).filter(Boolean);
  return { sounds, nextCursor: rows.length > limit && last ? Buffer.from(last.id).toString('base64url') : null };
}
export async function createCreatorSound(playerId: string, id: string, fields: SoundFields, status: 'Draft' | 'Published', key: string) {
  await withDevSoundDb(async db => {
    const inserted = await db.query(`INSERT INTO app.content (kind,id,status,status_missing,source,uploader_id,created_by,created_at,updated_at)
      VALUES ('sound',$1,$2,false,'revamp',$3,$4,now(),now()) ON CONFLICT (kind,id) DO NOTHING RETURNING id`, [id, status, playerId, `player:${playerId}`]);
    if (!inserted.rowCount) {
      if (!(await db.query(`${select} WHERE c.kind='sound' AND c.id=$1 AND c.uploader_id=$2 AND s.sound_key=$3`, [id, playerId, key])).rowCount) throw new ContributionError(409);
      return;
    }
    await db.query('INSERT INTO app.sounds (id,name,category,color,sound_key) VALUES ($1,$2,$3,0,$4)', [id, fields.name, fields.category, key]);
  });
}
export async function editCreatorSound(playerId: string, id: string, fields: SoundFields, requestedStatus: 'Draft' | 'Published' | undefined, requestedKey: unknown) {
  if (requestedKey !== undefined && typeof requestedKey !== 'string') throw new ContributionError(400);
  const requested = requestedKey === undefined ? undefined : adminSoundUploadKey(requestedKey, `player_${playerId}`);
  const current = await withDevSoundDb(async db => (await db.query<Row>(`${select} WHERE c.kind='sound' AND c.id=$1 AND c.uploader_id=$2 AND c.source='revamp'`, [id, playerId])).rows[0]);
  if (!current) throw new ContributionError(404);
  const oldKey = adminSoundUploadKey(current.sound_key, `player_${playerId}`), key = requested ?? oldKey;
  if (key !== oldKey) await verifySoundUpload(key);
  const status = await withDevSoundDb(async db => {
    const latest = (await db.query<Row>(`${select} WHERE c.kind='sound' AND c.id=$1 FOR UPDATE OF c,s`, [id])).rows[0];
    if (!latest || latest.uploader_id !== playerId || latest.source !== 'revamp') throw new ContributionError(404);
    if (latest.sound_key !== oldKey) throw new ContributionError(409);
    const next = requestedStatus ?? (latest.status === 'Draft' ? 'Draft' : 'Published');
    await db.query("UPDATE app.content SET status=$2,status_missing=false,updated_at=now() WHERE kind='sound' AND id=$1", [id, next]);
    await db.query('UPDATE app.sounds SET name=$2,category=$3,sound_key=$4 WHERE id=$1', [id, fields.name, fields.category, key]);
    return next;
  });
  if (key !== oldKey) await deleteSoundUpload(oldKey).catch(() => undefined);
  return { sound: { id, ...fields, status, file: await signedSoundUrl(key) } };
}
export async function deleteCreatorSound(playerId: string, id: string) {
  const key = await withDevSoundDb(async db => {
    const row = (await db.query<Row>(`${select} WHERE c.kind='sound' AND c.id=$1 FOR UPDATE OF c,s`, [id])).rows[0];
    if (!row || row.uploader_id !== playerId || row.source !== 'revamp') throw new ContributionError(404);
    const value = adminSoundUploadKey(row.sound_key, `player_${playerId}`);
    await db.query("DELETE FROM app.content WHERE kind='sound' AND id=$1", [id]);
    return value;
  });
  await deleteSoundUpload(key).catch(() => undefined);
}
export async function publicSoundKey(id: string) {
  return withDevSoundDb(async db => {
    const row = (await db.query<Row>(`${select} WHERE c.kind='sound' AND c.id=$1`, [id])).rows[0];
    return row && publicSound(row) ? row.sound_key : null;
  });
}
export async function recordSoundPlay(id: string, listenerHash: string, playerId: string | null) {
  return withDevSoundDb(async db => {
    const row = (await db.query<Row>(`${select} WHERE c.kind='sound' AND c.id=$1 FOR UPDATE OF c,s`, [id])).rows[0];
    if (!row || !publicSound(row)) return null;
    let unique = false;
    if (row.source === 'revamp' && row.uploader_id && row.uploader_id !== playerId) {
      unique = Boolean((await db.query("INSERT INTO app.content_visitors (content_kind,content_id,event,viewer_hash,first_seen_at) VALUES ('sound',$1,'listen',$2,now()) ON CONFLICT DO NOTHING RETURNING viewer_hash", [id, listenerHash])).rowCount);
    }
    const result = await db.query('UPDATE app.sounds SET play_count=play_count+1,listener_count=listener_count+$2 WHERE id=$1 RETURNING play_count', [id, Number(unique)]);
    return count(result.rows[0].play_count);
  });
}
export async function soundInsights(playerId: string) {
  return withDevSoundDb(async db => {
    const result = await db.query(`SELECT count(*) FILTER (WHERE c.status='Draft')::int AS drafts,count(*) FILTER (WHERE c.status IS DISTINCT FROM 'Draft')::int AS published,
      coalesce(sum(s.play_count),0)::text AS plays,coalesce(sum(s.listener_count),0)::text AS listeners FROM app.content c JOIN app.sounds s ON s.id=c.id AND s.kind=c.kind
      WHERE c.kind='sound' AND c.uploader_id=$1 AND c.source='revamp'`, [playerId]);
    const r = result.rows[0]; return { drafts: r.drafts as number, published: r.published as number, plays: count(r.plays), listeners: count(r.listeners) };
  });
}
export async function listStudioSounds(actor: StudioContentActor, url: URL) {
  if (!actor) throw new Error('studio.errors.unauthorized');
  const filter = characterListFilter(url, isStudioRoot(actor) ? null : actor.sub), cursor = parseCharacterListCursor(url.searchParams.get('cursor'), filter);
  const rows = await withDevSoundDb(async db => (await db.query<Row>(`${select} WHERE c.kind='sound' AND ($1::text IS NULL OR c.created_by=$1)
    AND ($2::text IS NULL OR c.status=$2) AND ($3='' OR strpos(lower(concat_ws(' ',s.name,s.category)),$3)>0)
    AND ($4::text IS NULL OR c.id COLLATE "C">$4 COLLATE "C") ORDER BY c.id COLLATE "C" LIMIT $5`, [filter.owner, filter.status, filter.query, cursor, filter.limit + 1])).rows);
  const page = rows.slice(0, filter.limit), last = page.at(-1);
  return { sounds: page.map(row => ({ id: row.id, name: row.name ?? '', category: row.category ?? 'Other', color: soundColor(row.color, 0),
    audioUrl: soundAudioUrl(url.origin, row.id), createdAt: row.created_at?.toISOString() ?? null, playCount: count(row.play_count) })),
    nextCursor: rows.length > filter.limit && last ? encodeCharacterListCursor(last.id, filter) : null };
}
export async function createStudioSound(actor: StudioContentActor, fields: SoundFields, key: string, colorValue: unknown, origin: string) {
  if (!actor) throw new Error('studio.errors.unauthorized');
  const id = randomUUID();
  return withDevSoundDb(async db => {
    const total = await db.query("SELECT count(*)::int AS n FROM app.sounds");
    const color = soundColor(colorValue, total.rows[0].n);
    await db.query("INSERT INTO app.content (kind,id,status,status_missing,created_by,created_at,updated_at) VALUES ('sound',$1,NULL,true,$2,now(),now())", [id, actor.sub]);
    await db.query('INSERT INTO app.sounds (id,name,category,color,sound_key) VALUES ($1,$2,$3,$4,$5)', [id, fields.name, fields.category, color, key]);
    return { id, ...fields, color, audioUrl: soundAudioUrl(origin, id), createdAt: null, playCount: 0 };
  });
}
