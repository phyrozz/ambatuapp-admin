import { randomUUID } from 'node:crypto';
import { ContributionError } from './community-content';
import { loreFields } from './community-contribution-validation';
import { LORE_TEXT_LIMIT, validateLoreTranslations } from './lore';
import { deleteCharacterImage, isPlayerLoreImageKey, signedCharacterImageUrl } from './s3-images';
import { isStudioRoot, type StudioContentActor } from './studio-content';
import { characterListFilter, encodeCharacterListCursor, parseCharacterListCursor } from './character-list-pagination';
import { withDevLoreDb } from './dev-content-db';

type LoreRow = { id: string; status: string | null; source: string | null; uploader_id: string | null; created_by: string | null;
  created_at: Date | null; updated_at: Date | null; cursor_time: string; view_count: string; upvotes: string; downvotes: string; comment_count: string;
  title: string | null; body: string | null; tags: unknown; translations: unknown; image_keys: unknown; extra: Record<string, unknown> };
type Fields = ReturnType<typeof loreFields>;
const time = "coalesce(c.created_at, '1970-01-01T00:00:00Z'::timestamptz)";
const select = `SELECT c.id,c.status,c.source,c.uploader_id,c.created_by,c.created_at,c.updated_at,c.view_count,c.upvotes,c.downvotes,c.comment_count,c.extra,
  to_char(${time} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,
  l.title,l.body,l.tags,l.translations,l.image_keys FROM app.content c JOIN app.lores l ON l.id=c.id AND l.kind=c.kind`;
const items = (value: unknown) => Array.isArray(value) ? value : [];
function count(value: string) { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid lore counter'); return n; }
function limit(value: string | null, fallback = 20) { const n = Number(value) || fallback; return Math.min(50, Math.max(1, Math.floor(Number.isFinite(n) ? n : fallback))); }
function cursorId(value: string | null) {
  if (!value) return null;
  try { const id = Buffer.from(value, 'base64url').toString('utf8'); if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) throw new Error(); return id; }
  catch { throw new ContributionError(400); }
}
async function creatorLore(row: LoreRow, owner: string) {
  const imageKeys = items(row.image_keys).filter((key): key is string => isPlayerLoreImageKey(key, owner));
  return { id: row.id, status: row.status === 'Draft' ? 'Draft' : 'Published', title: row.title ?? '', text: row.body ?? '',
    viewCount: count(row.view_count), upvotes: count(row.upvotes), downvotes: count(row.downvotes), commentCount: count(row.comment_count),
    tags: items(row.tags).filter((tag): tag is string => typeof tag === 'string'), translations: items(row.translations), imageKeys,
    imageUrls: await Promise.all(imageKeys.map(async key => (await signedCharacterImageUrl(key)) ?? '')), createdAt: row.created_at?.toISOString() ?? null };
}
async function studioLore(row: LoreRow) {
  const imageKeys = items(row.image_keys).filter((key): key is string => typeof key === 'string');
  return { ...row.extra, id: row.id, status: row.status ?? 'Draft', title: row.title ?? '', text: row.body ?? '',
    tags: items(row.tags), translations: items(row.translations), imageKeys, imageUrls: await Promise.all(imageKeys.map(signedCharacterImageUrl)),
    upvotes: count(row.upvotes), downvotes: count(row.downvotes), commentCount: count(row.comment_count),
    createdAt: row.created_at?.toISOString() ?? null, updatedAt: row.updated_at?.toISOString() ?? null,
    updated: typeof row.extra.updated === 'string' ? row.extra.updated : 'Recently' };
}
export async function listCreatorLores(playerId: string, url: URL) {
  const pageLimit = limit(url.searchParams.get('limit')), id = cursorId(url.searchParams.get('cursor'));
  const rows = await withDevLoreDb(async db => {
    let cursor: LoreRow | undefined;
    if (id) {
      cursor = (await db.query<LoreRow>(`${select} WHERE c.kind='lore' AND c.id=$1 AND c.uploader_id=$2 AND c.source='revamp'`, [id, playerId])).rows[0];
      if (!cursor) throw new ContributionError(400);
    }
    return (await db.query<LoreRow>(`${select} WHERE c.kind='lore' AND c.uploader_id=$1 AND c.source='revamp'
      AND ($2::timestamptz IS NULL OR (${time},c.id COLLATE "C")<($2::timestamptz,$3 COLLATE "C"))
      ORDER BY ${time} DESC,c.id COLLATE "C" DESC LIMIT $4`, [playerId, cursor?.cursor_time ?? null, cursor?.id ?? null, pageLimit + 1])).rows;
  });
  const page = rows.slice(0, pageLimit), last = page.at(-1);
  return { lores: await Promise.all(page.map(row => creatorLore(row, playerId))), nextCursor: rows.length > pageLimit && last ? Buffer.from(last.id).toString('base64url') : null };
}
export async function createCreatorLore(playerId: string, id: string, fields: Fields, status: 'Draft' | 'Published') {
  await withDevLoreDb(async db => {
    const added = await db.query(`INSERT INTO app.content (kind,id,status,status_missing,source,uploader_id,created_by,created_at,updated_at,extra)
      VALUES ('lore',$1,$2,false,'revamp',$3,$4,now(),now(),'{"updated":"Just now"}') ON CONFLICT (kind,id) DO NOTHING RETURNING id`, [id, status, playerId, `player:${playerId}`]);
    if (!added.rowCount) { const prior = await db.query("SELECT 1 FROM app.content WHERE kind='lore' AND id=$1 AND uploader_id=$2", [id, playerId]); if (!prior.rowCount) throw new ContributionError(409); return; }
    await db.query('INSERT INTO app.lores (id,title,body,tags,translations,image_keys) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)',
      [id, fields.title, fields.text, JSON.stringify(fields.tags), JSON.stringify(fields.translations), JSON.stringify(fields.imageKeys)]);
  });
}
export async function editCreatorLore(playerId: string, id: string, fields: Fields, requestedStatus?: 'Draft' | 'Published') {
  const result = await withDevLoreDb(async db => {
    const prior = (await db.query<LoreRow>(`${select} WHERE c.kind='lore' AND c.id=$1 FOR UPDATE OF c,l`, [id])).rows[0];
    if (!prior || prior.uploader_id !== playerId || prior.source !== 'revamp') throw new ContributionError(404);
    const status = requestedStatus ?? (prior.status === 'Draft' ? 'Draft' : 'Published');
    await db.query("UPDATE app.content SET status=$2,status_missing=false,updated_at=now(),extra=extra || '{\"updated\":\"Just now\"}'::jsonb WHERE kind='lore' AND id=$1", [id, status]);
    await db.query('UPDATE app.lores SET title=$2,body=$3,tags=$4::jsonb,translations=$5::jsonb,image_keys=$6::jsonb WHERE id=$1',
      [id, fields.title, fields.text, JSON.stringify(fields.tags), JSON.stringify(fields.translations), JSON.stringify(fields.imageKeys)]);
    return { status, oldImages: items(prior.image_keys).filter((key): key is string => typeof key === 'string') };
  });
  const retained = new Set(fields.imageKeys);
  await Promise.allSettled(result.oldImages.filter(key => !retained.has(key) && isPlayerLoreImageKey(key, playerId)).map(deleteCharacterImage));
  return { lore: { id, ...fields, status: result.status, imageUrls: await Promise.all(fields.imageKeys.map(async key => (await signedCharacterImageUrl(key)) ?? '')) } };
}
export async function deleteCreatorLore(playerId: string, id: string) {
  const keys = await withDevLoreDb(async db => {
    const prior = (await db.query<LoreRow>(`${select} WHERE c.kind='lore' AND c.id=$1 FOR UPDATE OF c,l`, [id])).rows[0];
    if (!prior || prior.uploader_id !== playerId || prior.source !== 'revamp') throw new ContributionError(404);
    await db.query("DELETE FROM app.content WHERE kind='lore' AND id=$1", [id]);
    return items(prior.image_keys).filter((key): key is string => isPlayerLoreImageKey(key, playerId));
  });
  await Promise.allSettled(keys.map(deleteCharacterImage));
}
export async function recordLoreView(id: string, viewerHash: string, playerId: string | null) {
  return withDevLoreDb(async db => {
    const result = await db.query("SELECT uploader_id FROM app.content WHERE kind='lore' AND id=$1 AND status='Published' AND source='revamp' FOR UPDATE", [id]);
    const uploader = result.rows[0]?.uploader_id;
    if (typeof uploader !== 'string' || playerId === uploader) return false;
    const inserted = await db.query("INSERT INTO app.content_visitors (content_kind,content_id,event,viewer_hash,first_seen_at) VALUES ('lore',$1,'view',$2,now()) ON CONFLICT DO NOTHING RETURNING viewer_hash", [id, viewerHash]);
    if (!inserted.rowCount) return false;
    await db.query("UPDATE app.content SET view_count=view_count+1 WHERE kind='lore' AND id=$1", [id]);
    return true;
  });
}
export async function loreInsights(playerId: string) {
  return withDevLoreDb(async db => {
    const r = await db.query(`SELECT count(*) FILTER (WHERE status='Draft')::int AS drafts,count(*) FILTER (WHERE status IS DISTINCT FROM 'Draft')::int AS published,
      coalesce(sum(view_count),0)::text AS views,coalesce(sum(upvotes),0)::text AS upvotes,coalesce(sum(downvotes),0)::text AS downvotes,
      coalesce(sum(comment_count),0)::text AS comments FROM app.content WHERE kind='lore' AND uploader_id=$1 AND source='revamp'`, [playerId]);
    const v = r.rows[0]; return { drafts: v.drafts as number, published: v.published as number, views: count(v.views), upvotes: count(v.upvotes), downvotes: count(v.downvotes), comments: count(v.comments) };
  });
}

export async function listStudioLores(actor: StudioContentActor, url: URL) {
  if (!actor) throw new Error('studio.errors.unauthorized');
  const filter = characterListFilter(url, isStudioRoot(actor) ? null : actor.sub);
  const cursor = parseCharacterListCursor(url.searchParams.get('cursor'), filter);
  const rows = await withDevLoreDb(async db => (await db.query<LoreRow>(`${select} WHERE c.kind='lore'
    AND ($1::text IS NULL OR c.created_by=$1) AND ($2::text IS NULL OR c.status=$2)
    AND ($3='' OR strpos(lower(concat_ws(' ',l.title,l.body,(SELECT string_agg(value,' ') FROM jsonb_array_elements_text(l.tags) value))),$3)>0)
    AND ($4::text IS NULL OR c.id COLLATE "C">$4 COLLATE "C") ORDER BY c.id COLLATE "C" ASC LIMIT $5`,
  [filter.owner, filter.status, filter.query, cursor, filter.limit + 1])).rows);
  const page = rows.slice(0, filter.limit), last = page.at(-1);
  return { configured: true, lores: await Promise.all(page.map(studioLore)), nextCursor: rows.length > filter.limit && last ? encodeCharacterListCursor(last.id, filter) : null };
}
function studioFields(body: Record<string, unknown>, prior?: LoreRow) {
  const title = body.title === undefined ? prior?.title : body.title;
  const text = body.text === undefined ? prior?.body : body.text;
  const tags = body.tags === undefined ? prior?.tags ?? [] : body.tags;
  const translations = body.translations === undefined ? prior?.translations ?? [] : body.translations;
  const imageKeys = body.imageKeys === undefined ? prior?.image_keys ?? [] : body.imageKeys;
  const status = body.status === undefined ? prior?.status ?? 'Draft' : body.status;
  if (typeof title !== 'string' || typeof text !== 'string' || !text.trim() || text.length > LORE_TEXT_LIMIT
    || !Array.isArray(tags) || tags.some(tag => typeof tag !== 'string') || !Array.isArray(translations)
    || !Array.isArray(imageKeys) || imageKeys.some(key => typeof key !== 'string') || (status !== 'Draft' && status !== 'Published')) throw new Error('studio.errors.request');
  validateLoreTranslations(translations);
  return { title, text, tags, translations, imageKeys: imageKeys as string[], status };
}
function checkOwner(actor: StudioContentActor, prior: LoreRow) {
  if (!actor || (!isStudioRoot(actor) && prior.created_by !== actor.sub)) throw new Error('studio.errors.forbidden');
}
function checkImages(actor: StudioContentActor, keys: string[], prior?: LoreRow) {
  const existing = new Set(items(prior?.image_keys));
  if (actor && !isStudioRoot(actor) && keys.some(key => !existing.has(key) && !key.startsWith(`lores/${actor.sub}/`))) throw new Error('studio.errors.forbidden');
}
export async function createStudioLore(actor: StudioContentActor, body: Record<string, unknown>) {
  if (!actor) throw new Error('studio.errors.unauthorized');
  const fields = studioFields(body), id = randomUUID(); checkImages(actor, fields.imageKeys);
  const row = await withDevLoreDb(async db => {
    await db.query(`INSERT INTO app.content (kind,id,status,status_missing,created_by,created_at,updated_at,extra)
      VALUES ('lore',$1,$2,false,$3,now(),now(),'{"updated":"Just now"}')`, [id, fields.status, actor.sub]);
    await db.query('INSERT INTO app.lores (id,title,body,tags,translations,image_keys) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)',
      [id, fields.title, fields.text, JSON.stringify(fields.tags), JSON.stringify(fields.translations), JSON.stringify(fields.imageKeys)]);
    return (await db.query<LoreRow>(`${select} WHERE c.kind='lore' AND c.id=$1`, [id])).rows[0];
  });
  return studioLore(row);
}
export async function editStudioLore(actor: StudioContentActor, id: string, body: Record<string, unknown>) {
  const row = await withDevLoreDb(async db => {
    const prior = (await db.query<LoreRow>(`${select} WHERE c.kind='lore' AND c.id=$1 FOR UPDATE OF c,l`, [id])).rows[0];
    if (!prior) throw new Error('studio.errors.forbidden'); checkOwner(actor, prior);
    const fields = studioFields(body, prior); checkImages(actor, fields.imageKeys, prior);
    await db.query("UPDATE app.content SET status=$2,status_missing=false,updated_at=now(),extra=extra || '{\"updated\":\"Just now\"}'::jsonb WHERE kind='lore' AND id=$1", [id, fields.status]);
    await db.query('UPDATE app.lores SET title=$2,body=$3,tags=$4::jsonb,translations=$5::jsonb,image_keys=$6::jsonb WHERE id=$1',
      [id, fields.title, fields.text, JSON.stringify(fields.tags), JSON.stringify(fields.translations), JSON.stringify(fields.imageKeys)]);
    return (await db.query<LoreRow>(`${select} WHERE c.kind='lore' AND c.id=$1`, [id])).rows[0];
  });
  return studioLore(row);
}
export async function deleteStudioLore(actor: StudioContentActor, id: string) {
  await withDevLoreDb(async db => {
    const prior = (await db.query<LoreRow>(`${select} WHERE c.kind='lore' AND c.id=$1 FOR UPDATE OF c,l`, [id])).rows[0];
    if (!prior) throw new Error('studio.errors.forbidden'); checkOwner(actor, prior);
    await Promise.all(items(prior.image_keys).filter((key): key is string => typeof key === 'string').map(deleteCharacterImage));
    await db.query("DELETE FROM app.content WHERE kind='lore' AND id=$1", [id]);
  });
}
