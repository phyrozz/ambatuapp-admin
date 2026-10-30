import { randomUUID } from 'node:crypto';
import { deleteVideoAssets, type VideoStatus } from './admin-video';
import { signedVideoUrl } from './s3-videos';
import { isStudioRoot, type StudioContentActor } from './studio-content';
import { characterListFilter, encodeCharacterListCursor, parseCharacterListCursor } from './character-list-pagination';
import { withDevVideoDb } from './dev-content-db';
import { profileAvatarUrl } from './profile-avatars';
import { fallbackPlayerName } from './player-profiles';

type VideoRow = { id: string; status: VideoStatus | null; uploader_id: string | null; created_by: string | null; created_at: Date | null;
  upvotes: string; downvotes: string; comment_count: string; title: string | null; description: string | null; video_key: string | null;
  thumbnail_key: string | null; uploader_name: string | null; uploader_email: string | null };
type Fields = { title: string; description: string; status: VideoStatus };
type Keys = { videoKey: string; thumbnailKey: string };
const select = `SELECT c.id,c.status,c.uploader_id,c.created_by,c.created_at,c.upvotes,c.downvotes,c.comment_count,
  v.title,v.description,v.video_key,v.thumbnail_key,v.uploader_name,v.uploader_email
  FROM app.content c JOIN app.videos v ON v.id=c.id AND v.kind=c.kind`;
function count(value: string) { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid video counter'); return n; }
async function studioVideo(row: VideoRow) {
  return { id: row.id, title: row.title ?? '', description: row.description ?? '', status: row.status ?? 'Draft', uploaderEmail: row.uploader_email ?? 'Unknown',
    upvotes: count(row.upvotes), downvotes: count(row.downvotes), commentCount: count(row.comment_count), createdAt: row.created_at?.toISOString() ?? null,
    videoUrl: row.video_key ? await signedVideoUrl(row.video_key) : '', thumbnailUrl: row.thumbnail_key ? await signedVideoUrl(row.thumbnail_key) : '' };
}
export async function listStudioVideos(actor: StudioContentActor, url: URL) {
  const filter = characterListFilter(url, isStudioRoot(actor) ? null : actor!.sub);
  const cursor = parseCharacterListCursor(url.searchParams.get('cursor'), filter);
  const rows = await withDevVideoDb(async db => (await db.query<VideoRow>(`${select} WHERE c.kind='video' AND ($1::text IS NULL OR c.created_by=$1)
    AND ($2::text IS NULL OR c.status=$2) AND ($3='' OR strpos(lower(concat_ws(' ',v.title,v.description,v.uploader_email)),$3)>0)
    AND ($4::text IS NULL OR c.id COLLATE "C">$4 COLLATE "C") ORDER BY c.id COLLATE "C" LIMIT $5`,
  [filter.owner, filter.status, filter.query, cursor, filter.limit + 1])).rows);
  const page = rows.slice(0, filter.limit), last = page.at(-1);
  return { videos: await Promise.all(page.map(studioVideo)), nextCursor: rows.length > filter.limit && last ? encodeCharacterListCursor(last.id, filter) : null };
}
export async function createVideo(fields: Fields, keys: Keys, owner: { uploaderId: string; name: string; email: string; createdBy?: string }) {
  const id = randomUUID();
  return withDevVideoDb(async db => {
    await db.query("INSERT INTO app.content (kind,id,status,status_missing,uploader_id,created_by,created_at,updated_at) VALUES ('video',$1,$2,false,$3,$4,now(),now())", [id, fields.status, owner.uploaderId, owner.createdBy ?? null]);
    await db.query('INSERT INTO app.videos (id,title,description,video_key,thumbnail_key,uploader_name,uploader_email) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, fields.title, fields.description, keys.videoKey, keys.thumbnailKey, owner.name, owner.email]);
    return (await db.query<VideoRow>(`${select} WHERE c.kind='video' AND c.id=$1`, [id])).rows[0];
  });
}
export async function createStudioVideo(actor: (NonNullable<StudioContentActor> & { email?: string; profile?: { displayName?: string } }) | undefined, fields: Fields, keys: Keys) {
  const row = await createVideo(fields, keys, { uploaderId: 'admin', name: actor?.profile?.displayName ?? 'Ambatu Admin', email: actor?.email ?? 'Ambatu Admin', createdBy: actor?.sub });
  return studioVideo(row);
}

type FeedRow = VideoRow & { cursor_time: string; username: string | null; avatar_key: string | null; user_vote: number | null };
const feedSelect = `SELECT c.id,c.status,c.uploader_id,c.created_by,c.created_at,c.upvotes,c.downvotes,c.comment_count,
  v.title,v.description,v.video_key,v.thumbnail_key,v.uploader_name,v.uploader_email,p.username,p.avatar_key,vote.value AS user_vote,
  to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
  FROM app.content c JOIN app.videos v ON v.id=c.id AND v.kind=c.kind
  LEFT JOIN app.player_profiles p ON p.id=c.uploader_id
  LEFT JOIN app.content_votes vote ON vote.content_kind=c.kind AND vote.content_id=c.id AND vote.voter_key=$1`;
function feedCursor(raw: string | null, scope: string) {
  if (!raw) return null;
  try {
    if (raw.length > 4096) throw new Error();
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { scope: string; time: string; id: string };
    if (value.scope !== scope || typeof value.id !== 'string' || !/^[\w-]{1,128}$/.test(value.id) || typeof value.time !== 'string'
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value.time) || !Number.isFinite(Date.parse(value.time))) throw new Error();
    return value;
  } catch { throw new Error('INVALID_CURSOR'); }
}
function nextFeedCursor(row: FeedRow, scope: string) { return Buffer.from(JSON.stringify({ scope, time: row.cursor_time, id: row.id })).toString('base64url'); }
async function scrollVideo(row: FeedRow) {
  const uploaderId = row.uploader_id && row.uploader_id !== 'admin' ? row.uploader_id : null;
  return { id: row.id, title: row.title ?? '', description: row.description ?? '', uploader: (uploaderId ? row.username : null) ?? row.uploader_name ?? fallbackPlayerName(row.uploader_email ?? ''),
    uploaderId, uploaderAvatarUrl: uploaderId ? await profileAvatarUrl(row.avatar_key ?? undefined) : null,
    videoUrl: await signedVideoUrl(row.video_key ?? ''), downloadUrl: await signedVideoUrl(row.video_key ?? '', `${row.id}.mp4`),
    thumbnailUrl: row.thumbnail_key ? await signedVideoUrl(row.thumbnail_key) : '', upvotes: count(row.upvotes), downvotes: count(row.downvotes),
    commentCount: count(row.comment_count), userVote: row.user_vote ?? 0 };
}
export async function listScrollVideos(playerId: string, raw: string | null) {
  const scope = 'scroll', cursor = feedCursor(raw, scope);
  const rows = await withDevVideoDb(async db => (await db.query<FeedRow>(`${feedSelect} WHERE c.kind='video' AND c.status='Published' AND c.created_at IS NOT NULL AND v.video_key IS NOT NULL AND v.video_key<>''
    AND ($2::timestamptz IS NULL OR (c.created_at,c.id COLLATE "C")<($2::timestamptz,$3 COLLATE "C"))
    ORDER BY c.created_at DESC,c.id COLLATE "C" DESC LIMIT 9`, [`user:${playerId}`, cursor?.time ?? null, cursor?.id ?? null])).rows);
  const page = rows.slice(0, 8), last = page.at(-1);
  return { videos: await Promise.all(page.map(scrollVideo)), nextCursor: rows.length > 8 && last ? nextFeedCursor(last, scope) : null };
}
export async function getScrollVideo(playerId: string, id: string) {
  const row = await withDevVideoDb(async db => (await db.query<FeedRow>(`${feedSelect} WHERE c.kind='video' AND c.status='Published' AND c.id=$2 AND v.video_key IS NOT NULL AND v.video_key<>''`, [`user:${playerId}`, id])).rows[0]);
  return row ? scrollVideo(row) : null;
}
export async function listCreatorClips(owner: string, playerId: string, raw: string | null) {
  const own = owner === playerId, scope = `creator:${owner}:${own}`, cursor = feedCursor(raw, scope);
  const rows = await withDevVideoDb(async db => (await db.query<FeedRow>(`${feedSelect} WHERE c.kind='video' AND c.uploader_id=$2 AND ($3::boolean OR c.status='Published') AND c.created_at IS NOT NULL
    AND ($4::timestamptz IS NULL OR (c.created_at,c.id COLLATE "C")<($4::timestamptz,$5 COLLATE "C"))
    ORDER BY c.created_at DESC,c.id COLLATE "C" DESC LIMIT 13`, [`user:${playerId}`, owner, own, cursor?.time ?? null, cursor?.id ?? null])).rows);
  const page = rows.slice(0, 12), last = page.at(-1);
  const clips = await Promise.all(page.map(async row => ({ id: row.id, title: row.title ?? '', description: row.description ?? '',
    thumbnailUrl: row.thumbnail_key ? await signedVideoUrl(row.thumbnail_key) : null, status: row.status === 'Published' ? 'Published' : 'Draft',
    playable: row.status === 'Published' && !!row.video_key, createdAt: row.created_at?.toISOString() ?? null, upvotes: count(row.upvotes), commentCount: count(row.comment_count) })));
  return { clips, nextCursor: rows.length > 12 && last ? nextFeedCursor(last, scope) : null };
}
export async function creatorClipCount(owner: string, own: boolean) {
  return withDevVideoDb(async db => {
    const result = await db.query("SELECT count(*)::int AS n FROM app.content WHERE kind='video' AND uploader_id=$1 AND ($2::boolean OR status='Published')", [owner, own]);
    return result.rows[0].n as number;
  });
}
function studioAllowed(actor: StudioContentActor, row: VideoRow) { return isStudioRoot(actor) || row.created_by === actor?.sub; }
export async function editStudioVideo(actor: StudioContentActor, id: string, fields: Fields, keys?: Keys) {
  const result = await withDevVideoDb(async db => {
    const prior = (await db.query<VideoRow>(`${select} WHERE c.kind='video' AND c.id=$1 FOR UPDATE OF c,v`, [id])).rows[0];
    if (!prior || !studioAllowed(actor, prior)) return null;
    await db.query("UPDATE app.content SET status=$2,status_missing=false,updated_at=now() WHERE kind='video' AND id=$1", [id, fields.status]);
    await db.query('UPDATE app.videos SET title=$2,description=$3,video_key=$4,thumbnail_key=$5 WHERE id=$1', [id, fields.title, fields.description, keys?.videoKey ?? prior.video_key, keys?.thumbnailKey ?? prior.thumbnail_key]);
    return { row: (await db.query<VideoRow>(`${select} WHERE c.kind='video' AND c.id=$1`, [id])).rows[0], prior };
  });
  if (!result) return null;
  if (keys && keys.videoKey !== result.prior.video_key) await deleteVideoAssets({ videoKey: result.prior.video_key, thumbnailKey: result.prior.thumbnail_key }).catch(() => undefined);
  return studioVideo(result.row);
}
export async function editPlayerVideo(playerId: string, id: string, title: string, description: string) {
  return withDevVideoDb(async db => {
    const result = await db.query("UPDATE app.content SET updated_at=now() WHERE kind='video' AND id=$1 AND status='Published' AND uploader_id=$2 RETURNING id", [id, playerId]);
    if (!result.rowCount) return false;
    await db.query('UPDATE app.videos SET title=$2,description=$3 WHERE id=$1', [id, title, description]);
    return true;
  });
}
export async function deleteManagedVideo(id: string, actor: StudioContentActor, playerId?: string) {
  const row = await withDevVideoDb(async db => {
    const prior = (await db.query<VideoRow>(`${select} WHERE c.kind='video' AND c.id=$1 FOR UPDATE OF c,v`, [id])).rows[0];
    if (!prior || (playerId ? prior.status !== 'Published' || prior.uploader_id !== playerId : !studioAllowed(actor, prior))) return null;
    if (playerId) {
      const videoPrefix = `videos/${playerId}/`, thumbPrefix = `video-thumbnails/${playerId}/`;
      const video = prior.video_key?.startsWith(videoPrefix) ? prior.video_key.slice(videoPrefix.length) : '';
      const thumb = prior.thumbnail_key?.startsWith(thumbPrefix) ? prior.thumbnail_key.slice(thumbPrefix.length) : '';
      if (!/^[a-f0-9-]{36}\.mp4$/i.test(video) || (thumb && (!/^[a-f0-9-]{36}\.jpg$/i.test(thumb) || thumb.slice(0, -4) !== video.slice(0, -4)))) throw new Error('Invalid video assets');
    }
    await db.query("DELETE FROM app.content WHERE kind='video' AND id=$1", [id]);
    return prior;
  });
  if (!row) return false;
  const videoKey = playerId && !row.video_key?.startsWith(`videos/${playerId}/`) ? null : row.video_key;
  const thumbnailKey = playerId && !row.thumbnail_key?.startsWith(`video-thumbnails/${playerId}/`) ? null : row.thumbnail_key;
  await deleteVideoAssets({ videoKey, thumbnailKey }).catch(() => undefined);
  return true;
}
