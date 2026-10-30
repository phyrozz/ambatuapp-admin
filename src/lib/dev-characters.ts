import { randomUUID } from 'node:crypto';
import { ContributionError } from './community-content';
import { playerCharacterFields } from './player-character';
import { characterImageKey, deleteCharacterImage, signedCharacterImageUrl, verifyPlayerCharacterImage } from './s3-images';
import { isStudioRoot, type StudioContentActor } from './studio-content';
import { withDevCharacterDb } from './dev-content-db';
import { characterListFilter, encodeCharacterListCursor, parseCharacterListCursor } from './character-list-pagination';

type CharacterRow = {
  id: string; name: string | null; title: string | null; bio: string | null; tags: unknown;
  status: string | null; source: string | null; uploader_id: string | null; created_by: string | null;
  created_at: Date | null; updated_at: Date | null; image_key: string | null; legacy_image: string | null;
  view_count: string; extra: Record<string, unknown>; cursor_time: string; updated_cursor: string;
};
const time = "coalesce(c.created_at, '1970-01-01T00:00:00Z'::timestamptz)";
const updatedTime = "coalesce(c.updated_at, '1970-01-01T00:00:00Z'::timestamptz)";
const select = `SELECT c.id,c.status,c.source,c.uploader_id,c.created_by,c.created_at,c.updated_at,c.view_count,c.extra,
  to_char(${time} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,
  to_char(${updatedTime} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_cursor,
  ch.name,ch.title,ch.bio,ch.tags,ch.image_key,ch.legacy_image
  FROM app.content c JOIN app.characters ch ON ch.id=c.id AND ch.kind=c.kind`;
function count(value: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid character counter');
  return result;
}
async function toCreator(row: CharacterRow) {
  return { id: row.id, name: row.name ?? '', title: row.title ?? '', bio: row.bio ?? '', tags: Array.isArray(row.tags) ? row.tags : [],
    status: row.status, viewCount: count(row.view_count), imageKey: row.image_key,
    imageUrl: (await signedCharacterImageUrl(row.image_key ?? undefined)) ?? null, createdAt: row.created_at?.toISOString() ?? null };
}
async function toStudio(row: CharacterRow) {
  const imageKey = characterImageKey(row.image_key ?? undefined, row.legacy_image ?? undefined);
  return { ...row.extra, id: row.id, name: row.name ?? '', title: row.title ?? '', bio: row.bio ?? '',
    tags: Array.isArray(row.tags) ? row.tags : [], status: row.status ?? 'Draft', imageKey,
    imageUrl: await signedCharacterImageUrl(imageKey), updated: typeof row.extra.updated === 'string' ? row.extra.updated : 'Recently',
    createdAt: row.created_at?.toISOString() ?? null, updatedAt: row.updated_at?.toISOString() ?? null };
}
function creatorCursor(value: string | null) {
  if (!value) return null;
  try {
    const id = Buffer.from(value, 'base64url').toString('utf8');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) throw new Error();
    return id;
  } catch { throw new ContributionError(400); }
}
function boundedLimit(value: string | null, fallback = 20) {
  const requested = Number(value) || fallback;
  return Math.min(50, Math.max(1, Math.floor(Number.isFinite(requested) ? requested : fallback)));
}

export async function listCreatorCharacters(playerId: string, url: URL) {
  const limit = boundedLimit(url.searchParams.get('limit'));
  const id = creatorCursor(url.searchParams.get('cursor'));
  const rows = await withDevCharacterDb(async db => {
    let cursor: CharacterRow | undefined;
    if (id) {
      cursor = (await db.query<CharacterRow>(`${select} WHERE c.kind='character' AND c.id=$1 AND c.uploader_id=$2 AND c.source='revamp'`, [id, playerId])).rows[0];
      if (!cursor) throw new ContributionError(400);
    }
    return (await db.query<CharacterRow>(`${select} WHERE c.kind='character' AND c.uploader_id=$1 AND c.source='revamp'
      AND ($2::timestamptz IS NULL OR (${time}, c.id COLLATE "C") < ($2::timestamptz, $3 COLLATE "C"))
      ORDER BY ${time} DESC,c.id COLLATE "C" DESC LIMIT $4`, [playerId, cursor?.cursor_time ?? null, cursor?.id ?? null, limit + 1])).rows;
  });
  const page = rows.slice(0, limit), last = page.at(-1);
  return { characters: await Promise.all(page.map(toCreator)), nextCursor: rows.length > limit && last ? Buffer.from(last.id).toString('base64url') : null };
}

export async function createCreatorCharacter(playerId: string, id: string, fields: ReturnType<typeof playerCharacterFields>) {
  await withDevCharacterDb(async db => {
    const inserted = await db.query(`INSERT INTO app.content (kind,id,status,status_missing,source,uploader_id,created_by,created_at,updated_at,extra)
      VALUES ('character',$1,$2,false,'revamp',$3,$4,now(),now(),'{"updated":"Just now"}') ON CONFLICT (kind,id) DO NOTHING RETURNING id`,
    [id, fields.status, playerId, `player:${playerId}`]);
    if (!inserted.rowCount) {
      const prior = await db.query('SELECT 1 FROM app.content WHERE kind=\'character\' AND id=$1 AND uploader_id=$2 AND source=\'revamp\'', [id, playerId]);
      if (!prior.rowCount) throw new ContributionError(409);
      return;
    }
    await db.query('INSERT INTO app.characters (id,name,title,bio,tags,image_key) VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [id, fields.name, fields.title, fields.bio, JSON.stringify(fields.tags), fields.imageKey]);
  });
}

export async function editCreatorCharacter(playerId: string, id: string, body: Record<string, unknown>) {
  await withDevCharacterDb(async db => {
    const prior = (await db.query<CharacterRow>(`${select} WHERE c.kind='character' AND c.id=$1 FOR UPDATE OF c,ch`, [id])).rows[0];
    if (!prior || prior.uploader_id !== playerId || prior.source !== 'revamp') throw new ContributionError(404);
    const fields = playerCharacterFields(body, playerId, prior.image_key);
    if (fields.imageKey && fields.imageKey !== prior.image_key) await verifyPlayerCharacterImage(fields.imageKey);
    await db.query("UPDATE app.content SET status=$2,status_missing=false,updated_at=now(),extra=extra || '{\"updated\":\"Just now\"}'::jsonb WHERE kind='character' AND id=$1", [id, fields.status]);
    await db.query('UPDATE app.characters SET name=$2,title=$3,bio=$4,tags=$5::jsonb,image_key=$6 WHERE id=$1',
      [id, fields.name, fields.title, fields.bio, JSON.stringify(fields.tags), fields.imageKey]);
  });
}

export async function recordCharacterView(id: string, viewerHash: string, playerId: string | null) {
  return withDevCharacterDb(async db => {
    const content = await db.query('SELECT uploader_id FROM app.content WHERE kind=\'character\' AND id=$1 AND status=\'Published\' AND source=\'revamp\' FOR UPDATE', [id]);
    const uploader = content.rows[0]?.uploader_id;
    if (typeof uploader !== 'string' || playerId === uploader) return false;
    const inserted = await db.query(`INSERT INTO app.content_visitors (content_kind,content_id,event,viewer_hash,first_seen_at)
      VALUES ('character',$1,'view',$2,now()) ON CONFLICT DO NOTHING RETURNING viewer_hash`, [id, viewerHash]);
    if (!inserted.rowCount) return false;
    await db.query("UPDATE app.content SET view_count=view_count+1 WHERE kind='character' AND id=$1", [id]);
    return true;
  });
}

export async function characterInsights(playerId: string) {
  return withDevCharacterDb(async db => {
    const result = await db.query(`SELECT count(*) FILTER (WHERE status='Draft')::int AS drafts,
      count(*) FILTER (WHERE status IS DISTINCT FROM 'Draft')::int AS published,coalesce(sum(view_count),0)::text AS views
      FROM app.content WHERE kind='character' AND uploader_id=$1 AND source='revamp'`, [playerId]);
    return { drafts: result.rows[0].drafts as number, published: result.rows[0].published as number, views: count(result.rows[0].views) };
  });
}

export async function listStudioCharacters(actor: StudioContentActor, url: URL) {
  if (!actor) throw new Error('studio.errors.unauthorized');
  const owner = isStudioRoot(actor) ? null : actor.sub;
  const filter = characterListFilter(url, owner);
  const cursor = parseCharacterListCursor(url.searchParams.get('cursor'), filter);
  const rows = await withDevCharacterDb(async db => (await db.query<CharacterRow>(`${select}
    WHERE c.kind='character' AND ($1::text IS NULL OR c.created_by=$1)
    AND ($2::text IS NULL OR c.status=$2)
    AND ($3='' OR strpos(lower(concat_ws(' ',ch.name,ch.title,(SELECT string_agg(value,' ') FROM jsonb_array_elements_text(ch.tags) value))),$3)>0)
    AND ($4::text IS NULL OR c.id COLLATE "C">$4 COLLATE "C")
    ORDER BY c.id COLLATE "C" ASC LIMIT $5`,
  [owner, filter.status, filter.query, cursor, filter.limit + 1])).rows);
  const page = rows.slice(0, filter.limit), last = page.at(-1);
  return { configured: true, characters: await Promise.all(page.map(toStudio)),
    nextCursor: rows.length > filter.limit && last ? encodeCharacterListCursor(last.id, filter) : null };
}

function studioFields(body: Record<string, unknown>, fallback?: CharacterRow) {
  const name = body.name === undefined ? fallback?.name : body.name;
  const title = body.title === undefined ? fallback?.title : body.title;
  const bio = body.bio === undefined ? fallback?.bio : body.bio;
  const tags = body.tags === undefined ? fallback?.tags : body.tags;
  const status = body.status === undefined ? fallback?.status ?? 'Draft' : body.status;
  const imageKey = body.imageKey === undefined ? fallback?.image_key : body.imageKey;
  if (typeof name !== 'string' || !name.trim() || name.length > 120 || typeof title !== 'string' || title.length > 120
    || (bio !== null && bio !== undefined && (typeof bio !== 'string' || bio.length > 20000))
    || !Array.isArray(tags) || tags.length > 10 || tags.some(tag => typeof tag !== 'string' || tag.length > 40)
    || (status !== 'Draft' && status !== 'Published') || (imageKey !== null && imageKey !== undefined && typeof imageKey !== 'string')) {
    throw new Error('studio.errors.request');
  }
  return { name, title, bio: bio ?? '', tags, status, imageKey: imageKey ?? null };
}
function checkStudioOwner(actor: StudioContentActor, row: CharacterRow) {
  if (!actor || (!isStudioRoot(actor) && row.created_by !== actor.sub)) throw new Error('studio.errors.forbidden');
}
function checkStudioImage(actor: StudioContentActor, imageKey: string | null, previous?: CharacterRow) {
  if (actor && !isStudioRoot(actor) && imageKey && imageKey !== previous?.image_key && imageKey !== previous?.legacy_image && !imageKey.startsWith(`characters/${actor.sub}/`)) {
    throw new Error('studio.errors.forbidden');
  }
}
export async function createStudioCharacter(actor: StudioContentActor, body: Record<string, unknown>) {
  if (!actor) throw new Error('studio.errors.unauthorized');
  const fields = studioFields(body), id = randomUUID();
  checkStudioImage(actor, fields.imageKey);
  const row = await withDevCharacterDb(async db => {
    await db.query(`INSERT INTO app.content (kind,id,status,status_missing,created_by,created_at,updated_at,extra)
      VALUES ('character',$1,$2,false,$3,now(),now(),'{"updated":"Just now"}')`, [id, fields.status, actor.sub]);
    await db.query('INSERT INTO app.characters (id,name,title,bio,tags,image_key) VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [id, fields.name, fields.title, fields.bio, JSON.stringify(fields.tags), fields.imageKey]);
    return (await db.query<CharacterRow>(`${select} WHERE c.kind='character' AND c.id=$1`, [id])).rows[0];
  });
  return toStudio(row);
}
export async function editStudioCharacter(actor: StudioContentActor, id: string, body: Record<string, unknown>) {
  const row = await withDevCharacterDb(async db => {
    const prior = (await db.query<CharacterRow>(`${select} WHERE c.kind='character' AND c.id=$1 FOR UPDATE OF c,ch`, [id])).rows[0];
    if (!prior) throw new Error('studio.errors.forbidden');
    checkStudioOwner(actor, prior);
    const fields = studioFields(body, prior);
    checkStudioImage(actor, fields.imageKey, prior);
    await db.query("UPDATE app.content SET status=$2,status_missing=false,updated_at=now(),extra=extra || '{\"updated\":\"Just now\"}'::jsonb WHERE kind='character' AND id=$1", [id, fields.status]);
    await db.query('UPDATE app.characters SET name=$2,title=$3,bio=$4,tags=$5::jsonb,image_key=$6 WHERE id=$1',
      [id, fields.name, fields.title, fields.bio, JSON.stringify(fields.tags), fields.imageKey]);
    return (await db.query<CharacterRow>(`${select} WHERE c.kind='character' AND c.id=$1`, [id])).rows[0];
  });
  return toStudio(row);
}
export async function deleteStudioCharacter(actor: StudioContentActor, id: string) {
  await withDevCharacterDb(async db => {
    const prior = (await db.query<CharacterRow>(`${select} WHERE c.kind='character' AND c.id=$1 FOR UPDATE OF c,ch`, [id])).rows[0];
    if (!prior) throw new Error('studio.errors.forbidden');
    checkStudioOwner(actor, prior);
    await deleteCharacterImage(characterImageKey(prior.image_key ?? undefined, prior.legacy_image ?? undefined));
    await db.query("DELETE FROM app.content WHERE kind='character' AND id=$1", [id]);
  });
}
