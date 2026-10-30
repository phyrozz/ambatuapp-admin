import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { withDevContentDb } from './dev-content-db';
import { characterImageKey, signedCharacterImageUrl } from './s3-images';
import { signedVideoUrl } from './s3-videos';
import { profileAvatarUrl } from './profile-avatars';
import { soundAudioUrl, soundColor } from './admin-sounds';
import { validSoundAssetKey } from './s3-sounds';
import { playerFromRequest } from './player-auth';

type Kind = 'character' | 'lore' | 'sound' | 'video';
type Json = Record<string, unknown>;
type Row = {
  id: string; name: string | null; title: string | null; body: string | null;
  tags: unknown; image_keys: unknown; translations: unknown; image_key: string | null;
  legacy_image: string | null; legacy_description: string | null; category: string | null;
  color: number | null; sound_key: string | null; play_count: string | null;
  video_key: string | null; thumbnail_key: string | null; uploader_name: string | null;
  uploader_email: string | null; uploader_id: string | null; source: string | null;
  profile_name: string | null; avatar_key: string | null; status: string | null;
  upvotes: string; downvotes: string; comment_count: string; created_at: Date | null;
  cursor_time: string; vote: number | null;
};
type Cursor = { v: number; kind: Kind; key: string; id: string; name?: string; time?: string; votes?: number; comments?: number; asOf?: number; popular?: Cursor | null; fresh?: Cursor | null; freshDone?: boolean };
class InvalidCursor extends Error {}
const timeExpr = "coalesce(c.created_at, '1970-01-01T00:00:00Z'::timestamptz)";
const stampExpr = `to_char(${timeExpr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const baseSelect = `SELECT c.id,c.kind,c.status,c.source,c.uploader_id,c.created_at,c.upvotes,c.downvotes,c.comment_count,
  ${stampExpr} AS cursor_time, p.username AS profile_name,p.avatar_key,
  ch.name AS character_name,ch.title AS character_title,ch.bio AS character_bio,ch.tags AS character_tags,
  ch.image_key,ch.legacy_image,c.extra->>'description' AS legacy_description,
  l.title AS lore_title,l.body AS lore_body,l.tags AS lore_tags,l.image_keys,l.translations,
  s.name AS sound_name,s.category,s.color,s.sound_key,s.play_count,
  v.title AS video_title,v.description AS video_description,v.video_key,v.thumbnail_key,v.uploader_name,v.uploader_email
  FROM app.content c
  LEFT JOIN app.characters ch ON c.kind='character' AND ch.id=c.id
  LEFT JOIN app.lores l ON c.kind='lore' AND l.id=c.id
  LEFT JOIN app.sounds s ON c.kind='sound' AND s.id=c.id
  LEFT JOIN app.videos v ON c.kind='video' AND v.id=c.id
  LEFT JOIN app.player_profiles p ON p.id=c.uploader_id`;

function number(value: string | number | null | undefined) {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed)) throw new Error('Invalid content counter');
  return parsed;
}
function array(value: unknown) { return Array.isArray(value) ? value : []; }
function cursorKey(kind: Kind, key: unknown) { return JSON.stringify({ kind, key }); }
function encode(cursor: Cursor) { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
function decode(raw: string | null, kind: Kind, key: string): Cursor | null {
  if (!raw) return null;
  try {
    if (raw.length > 4096) throw new Error();
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const c = value as Cursor;
    if (c.v !== 1 || c.kind !== kind || c.key !== key || typeof c.id !== 'string' || c.id.length > 1500) throw new Error();
    if (kind === 'character' || kind === 'sound') {
      if (typeof c.name !== 'string' || c.name.length > 2048) throw new Error();
    } else if (kind !== 'video' || c.asOf === undefined) {
      if (typeof c.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(c.time)) throw new Error();
      if (c.votes !== undefined && (!Number.isSafeInteger(c.votes) || c.votes < 0)) throw new Error();
      if (c.comments !== undefined && (!Number.isSafeInteger(c.comments) || c.comments < 0)) throw new Error();
    } else {
      if (!Number.isSafeInteger(c.asOf) || c.asOf <= 0 || c.asOf > 253402300799999 || typeof c.freshDone !== 'boolean') throw new Error();
      for (const part of [c.popular, c.fresh]) {
        if (part !== null) {
          if (!part || typeof part.id !== 'string' || typeof part.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(part.time)) throw new Error();
          if (part === c.popular && (!Number.isSafeInteger(part.votes) || !Number.isSafeInteger(part.comments) || part.votes! < 0 || part.comments! < 0)) throw new Error();
        }
      }
    }
    return c;
  } catch { throw new InvalidCursor(); }
}
function limitOf(url: URL, fallback: number, maximum: number) {
  const n = Number(url.searchParams.get('limit')) || fallback;
  return Math.min(maximum, Math.max(1, Math.floor(Number.isFinite(n) ? n : fallback)));
}
function timeCursor(row: Row, kind: Kind, key: string): Cursor {
  return { v: 1, kind, key, id: row.id, time: row.cursor_time, votes: number(row.upvotes), comments: number(row.comment_count) };
}
function profileName(row: Row) { return row.profile_name || row.uploader_email?.split('@')[0] || 'Player'; }

async function toPublic(kind: Kind, raw: Json, origin: string): Promise<Json> {
  const row = raw as unknown as Row;
  if (kind === 'character') {
    const imageKey = characterImageKey(row.image_key ?? undefined, row.legacy_image ?? undefined);
    return { id: row.id, name: raw.character_name, title: raw.character_title ?? '', bio: raw.character_bio ?? row.legacy_description ?? '', tags: array(raw.character_tags), imageUrl: await signedCharacterImageUrl(imageKey) };
  }
  if (kind === 'lore') {
    const uploader = row.source === 'revamp' && typeof row.uploader_id === 'string';
    return { id: row.id, title: raw.lore_title, text: raw.lore_body, translations: array(row.translations), tags: array(raw.lore_tags),
      imageUrls: await Promise.all(array(row.image_keys).filter((x): x is string => typeof x === 'string').map(signedCharacterImageUrl)),
      upvotes: number(row.upvotes), downvotes: number(row.downvotes), commentCount: number(row.comment_count),
      uploaderId: uploader ? row.uploader_id : null, uploaderName: uploader ? profileName(row) : null };
  }
  if (kind === 'sound') {
    const uploader = row.source === 'revamp' && typeof row.uploader_id === 'string';
    return { id: row.id, name: raw.sound_name, category: row.category, color: soundColor(row.color, 0), file: soundAudioUrl(origin, row.id),
      createdAt: row.created_at?.toISOString() ?? null, playCount: number(row.play_count),
      uploaderId: uploader ? row.uploader_id : null, uploaderName: uploader ? profileName(row) : null };
  }
  const uploader = row.uploader_id ? profileName(row) : row.uploader_name ?? row.uploader_email;
  return { id: row.id, title: raw.video_title, description: raw.video_description ?? '', uploader,
    uploaderAvatarUrl: row.uploader_id ? await profileAvatarUrl(row.avatar_key ?? undefined) : null,
    uploaderId: row.uploader_id, thumbnailUrl: await signedVideoUrl(row.thumbnail_key ?? ''),
    upvotes: number(row.upvotes), downvotes: number(row.downvotes), commentCount: number(row.comment_count), createdAt: row.created_at?.toISOString() ?? null };
}

async function namedList(db: PoolClient, kind: 'character' | 'sound', url: URL) {
  const limit = limitOf(url, 12, 50);
  const search = kind === 'character' ? (url.searchParams.get('q') ?? '').trim().toLowerCase() : '';
  const desc = kind === 'character' && url.searchParams.get('sort') === 'nameDesc';
  const key = cursorKey(kind, { limit, search, desc });
  const cursor = decode(url.searchParams.get('cursor'), kind, key);
  const column = kind === 'character' ? 'ch.name' : 's.name';
  const direction = desc ? 'DESC' : 'ASC';
  const operator = desc ? '<' : '>';
  const result = await db.query(`${baseSelect} WHERE c.kind=$1 AND ${column} IS NOT NULL
    AND ($2='' OR strpos(lower(${column}),$2)>0)
    AND ($3::text IS NULL OR (${column} COLLATE "C",c.id COLLATE "C") ${operator} ($3 COLLATE "C",$4 COLLATE "C"))
    AND ($1 <> 'character' OR (c.status='Published' AND btrim(${column})<>''))
    AND ($1 <> 'sound' OR ((c.status='Published' OR c.status_missing) AND s.category IS NOT NULL
      AND s.sound_key ~ '^soundboard/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+\.(mp3|wav|ogg|m4a|webm|aac)$'))
    ORDER BY ${column} COLLATE "C" ${direction}, c.id COLLATE "C" ${direction} LIMIT $5`,
  [kind, search, cursor?.name ?? null, cursor?.id ?? null, limit + 1]);
  const rows = result.rows.slice(0, limit);
  const items = await Promise.all(rows.map(r => toPublic(kind, r, url.origin)));
  const last = rows.at(-1);
  const name = last?.[kind === 'character' ? 'character_name' : 'sound_name'];
  const nextCursor = result.rows.length > limit && last ? encode({ v: 1, kind, key, id: last.id, name }) : null;
  return kind === 'character' ? { characters: items, nextCursor } : { sounds: items, nextCursor };
}

async function loreList(db: PoolClient, url: URL) {
  const limit = limitOf(url, 12, 50);
  const search = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const tags = url.searchParams.getAll('tag').map(x => x.trim().toLowerCase()).filter(Boolean).sort();
  const language = (url.searchParams.get('language') ?? '').trim().toLowerCase();
  const sort = url.searchParams.get('sort') === 'newest' ? 'newest' : 'upvotes';
  const key = cursorKey('lore', { limit, search, tags, language, sort });
  const cursor = decode(url.searchParams.get('cursor'), 'lore', key);
  if (cursor && sort === 'upvotes' && cursor.votes === undefined) throw new InvalidCursor();
  const filter = `c.kind='lore' AND c.status='Published'
    AND ($1='' OR strpos(lower(concat_ws(' ', l.title,l.body,coalesce((SELECT string_agg(coalesce(t->>'title','') || ' ' || coalesce(t->>'text',''),' ') FROM jsonb_array_elements(l.translations) t),''))),$1)>0)
    AND NOT EXISTS (SELECT 1 FROM unnest($2::text[]) selected WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(l.tags) t WHERE lower(t)=selected))
    AND ($3='' OR $3='original' OR EXISTS (SELECT 1 FROM jsonb_array_elements(l.translations) t WHERE lower(t->>'locale')=$3))`;
  const after = sort === 'upvotes'
    ? `(c.upvotes < $5::bigint OR (c.upvotes=$5 AND (${timeExpr} < $4::timestamptz OR (${timeExpr}=$4 AND c.id COLLATE "C">$6 COLLATE "C"))))`
    : `(${timeExpr} < $4::timestamptz OR (${timeExpr}=$4 AND c.id COLLATE "C">$6 COLLATE "C"))`;
  const order = sort === 'upvotes' ? `c.upvotes DESC, ${timeExpr} DESC, c.id COLLATE "C" ASC` : `${timeExpr} DESC, c.id COLLATE "C" ASC`;
  const values = [search, tags, language];
  const page = await db.query(`${baseSelect} WHERE ${filter} AND $5::bigint IS NOT NULL AND ($4::timestamptz IS NULL OR ${after}) ORDER BY ${order} LIMIT $7`, [...values, cursor?.time ?? null, cursor?.votes ?? 0, cursor?.id ?? null, limit + 1]);
  const count = await db.query(`SELECT count(*)::int AS n FROM app.content c JOIN app.lores l ON l.id=c.id WHERE ${filter}`, values);
  const tagFacets = await db.query("SELECT DISTINCT t.value AS tag FROM app.content c JOIN app.lores l ON l.id=c.id CROSS JOIN LATERAL jsonb_array_elements_text(l.tags) t(value) WHERE c.kind='lore' AND c.status='Published' ORDER BY tag");
  const languageFacets = await db.query("SELECT DISTINCT ON (lower(t->>'locale')) lower(t->>'locale') AS locale,t->>'label' AS label FROM app.content c JOIN app.lores l ON l.id=c.id CROSS JOIN LATERAL jsonb_array_elements(l.translations) t WHERE c.kind='lore' AND c.status='Published' AND coalesce(t->>'locale','')<>'' AND coalesce(t->>'label','')<>'' ORDER BY lower(t->>'locale'),t->>'label'");
  const rows = page.rows.slice(0, limit);
  const last = rows.at(-1);
  return { lores: await Promise.all(rows.map(row => toPublic('lore', row, url.origin))), totalCount: count.rows[0].n,
    nextCursor: page.rows.length > limit && last ? encode(timeCursor(last, 'lore', key)) : null,
    facets: { tags: tagFacets.rows.map(r => r.tag), languages: languageFacets.rows } };
}

async function videoList(db: PoolClient, url: URL) {
  const limit = limitOf(url, 8, 18);
  const sort = url.searchParams.get('sort') === 'newest' ? 'newest' : url.searchParams.get('sort') === 'relevance' ? 'relevance' : 'upvotes';
  const key = cursorKey('video', { limit, sort });
  const cursor = decode(url.searchParams.get('cursor'), 'video', key);
  let rows: Json[];
  let nextCursor: string | null;
  if (sort === 'relevance') {
    if (cursor && cursor.asOf === undefined) throw new InvalidCursor();
    const asOf = cursor?.asOf ?? Date.now();
    const popular = cursor?.popular ?? null;
    const fresh = cursor?.fresh ?? null;
    const popularResult = await db.query(`${baseSelect} WHERE c.kind='video' AND c.status='Published' AND c.created_at IS NOT NULL
      AND ($1::bigint IS NULL OR c.upvotes<$1 OR (c.upvotes=$1 AND (c.comment_count<$2 OR (c.comment_count=$2
        AND (c.created_at<$3::timestamptz OR (c.created_at=$3 AND c.id COLLATE "C">$4 COLLATE "C"))))))
      AND ($6::timestamptz IS NULL OR NOT (c.created_at BETWEEN to_timestamp($8::double precision / 1000.0) - interval '7 days' AND to_timestamp($8::double precision / 1000.0)
        AND (c.created_at>$6 OR (c.created_at=$6 AND c.id COLLATE "C"<=$7 COLLATE "C"))))
      ORDER BY c.upvotes DESC,c.comment_count DESC,c.created_at DESC,c.id COLLATE "C" ASC LIMIT $5`,
    [popular?.votes ?? null, popular?.comments ?? null, popular?.time ?? null, popular?.id ?? null, limit + 1, fresh?.time ?? null, fresh?.id ?? null, asOf]);
    const freshResult = cursor?.freshDone ? { rows: [] } : await db.query(`${baseSelect} WHERE c.kind='video' AND c.status='Published'
      AND c.created_at >= to_timestamp($1::double precision / 1000.0) - interval '7 days' AND c.created_at <= to_timestamp($1::double precision / 1000.0)
      AND ($2::timestamptz IS NULL OR c.created_at<$2 OR (c.created_at=$2 AND c.id COLLATE "C">$3 COLLATE "C"))
      AND ($4::bigint IS NULL OR NOT (c.upvotes>$4 OR (c.upvotes=$4 AND (c.comment_count>$5 OR (c.comment_count=$5
        AND (c.created_at>$6::timestamptz OR (c.created_at=$6 AND c.id COLLATE "C"<=$7 COLLATE "C")))))))
      ORDER BY c.created_at DESC,c.id COLLATE "C" ASC LIMIT 2`, [asOf, fresh?.time ?? null, fresh?.id ?? null,
      popular?.votes ?? null, popular?.comments ?? null, popular?.time ?? null, popular?.id ?? null]);
    const popularPage = popularResult.rows.slice(0, limit);
    const freshVideo = freshResult.rows[0];
    const ordered = [...popularPage];
    if (freshVideo) {
      const duplicate = ordered.findIndex(r => r.id === freshVideo.id);
      if (duplicate >= 0) ordered.splice(duplicate, 1);
      const score = (r: Row) => number(r.upvotes) + number(r.comment_count) * .5 + Math.max(0, Math.min(1, 1 - Math.max(0, asOf - (r.created_at?.getTime() ?? asOf)) / (7 * 24 * 60 * 60 * 1000))) * 5;
      const insertAt = ordered[0] && score(ordered[0]) >= score(freshVideo) ? 1 : 0;
      ordered.splice(Math.min(insertAt, ordered.length), 0, freshVideo);
    }
    rows = ordered.slice(0, limit);
    let consumed = 0;
    while (consumed < popularPage.length && rows.some(r => r.id === popularPage[consumed].id)) consumed++;
    const nextPopular = consumed ? timeCursor(popularPage[consumed - 1], 'video', key) : popular;
    const freshEmitted = Boolean(freshVideo && rows.some(r => r.id === freshVideo.id));
    const nextFresh = freshEmitted ? timeCursor(freshVideo, 'video', key) : fresh;
    const morePopular = consumed < popularResult.rows.length;
    const moreFresh = Boolean(freshVideo && (!freshEmitted || freshResult.rows.length > 1));
    nextCursor = morePopular || moreFresh ? encode({ v: 1, kind: 'video', key, id: '', asOf, popular: nextPopular, fresh: nextFresh, freshDone: Boolean(cursor?.freshDone || !moreFresh) }) : null;
  } else {
    if (cursor?.asOf !== undefined || (cursor && sort === 'upvotes' && cursor.votes === undefined)) throw new InvalidCursor();
    const after = sort === 'upvotes'
      ? `(c.upvotes<$2::bigint OR (c.upvotes=$2 AND (${timeExpr}<$1::timestamptz OR (${timeExpr}=$1 AND c.id COLLATE "C">$3 COLLATE "C"))))`
      : `(${timeExpr}<$1::timestamptz OR (${timeExpr}=$1 AND c.id COLLATE "C">$3 COLLATE "C"))`;
    const order = sort === 'upvotes' ? `c.upvotes DESC,${timeExpr} DESC,c.id COLLATE "C" ASC` : `${timeExpr} DESC,c.id COLLATE "C" ASC`;
    const result = await db.query(`${baseSelect} WHERE c.kind='video' AND c.status='Published'
      AND $2::bigint IS NOT NULL AND ($1::timestamptz IS NULL OR ${after}) ORDER BY ${order} LIMIT $4`, [cursor?.time ?? null, cursor?.votes ?? 0, cursor?.id ?? null, limit + 1]);
    rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    nextCursor = result.rows.length > limit && last ? encode(timeCursor(last as unknown as Row, 'video', key)) : null;
  }
  return { videos: await Promise.all(rows.map(row => toPublic('video', row, url.origin))), nextCursor };
}

async function detail(db: PoolClient, kind: Kind, request: Request, id: string) {
  if (kind === 'sound' && !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  const result = await db.query(`${baseSelect} WHERE c.kind=$1 AND c.id=$2
    AND (c.status='Published' OR (c.kind='sound' AND c.status_missing))`, [kind, id]);
  const row = result.rows[0];
  if (!row) return null;
  if (kind === 'sound' && (!validSoundAssetKey(row.sound_key) || typeof row.sound_name !== 'string' || typeof row.category !== 'string')) return null;
  const item = await toPublic(kind, row, new URL(request.url).origin);
  if (kind === 'sound') {
    const { uploaderId: _uploaderId, uploaderName: _uploaderName, ...sound } = item;
    return { sound };
  }
  if (kind === 'character') return item;
  let player: Awaited<ReturnType<typeof playerFromRequest>> = null;
  if (kind === 'video') { try { player = await playerFromRequest(request); } catch {} }
  else player = await playerFromRequest(request);
  const vote = player ? await db.query('SELECT value FROM app.content_votes WHERE content_kind=$1 AND content_id=$2 AND voter_key=$3', [kind, id, kind === 'video' ? `user:${player.id}` : player.id]) : null;
  const userVote = vote?.rows[0]?.value ?? 0;
  if (kind === 'lore') return { ...item, userVote };
  const { createdAt: _createdAt, ...video } = item;
  return { ...video, videoUrl: await signedVideoUrl(row.video_key ?? ''), userVote };
}

const headers: Record<Kind, Record<string, string>> = {
  character: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' },
  lore: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=30', 'Access-Control-Allow-Headers': 'authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
  sound: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' },
  video: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Cache-Control': 'no-store' },
};
const names: Record<Kind, string> = { character: 'Character', lore: 'Lore', sound: 'Sound', video: 'Video' };
export async function devContentRead(kind: Kind, request: Request, id?: string) {
  const responseHeaders = kind === 'lore' && id ? { ...headers.lore, 'Cache-Control': 'private, no-store' } : headers[kind];
  try {
    const body = await withDevContentDb(async db => {
      if (id !== undefined) return detail(db, kind, request, id);
      const url = new URL(request.url);
      if (kind === 'character' || kind === 'sound') return namedList(db, kind, url);
      if (kind === 'lore') return loreList(db, url);
      return videoList(db, url);
    });
    if (!body) return NextResponse.json({ error: `${names[kind]} not found.` }, { status: 404, headers: responseHeaders });
    return NextResponse.json(body, { headers: responseHeaders });
  } catch (error) {
    if (error instanceof InvalidCursor) return NextResponse.json({ error: `Invalid ${kind === 'sound' ? 'sound catalog' : kind} cursor.` }, { status: 400, headers: responseHeaders });
    console.error('Dev snapshot content read failed', error instanceof Error ? error.message : 'unknown error');
    return NextResponse.json({ error: kind === 'sound' ? 'Could not load sounds.' : `${names[kind]} service is not configured.` }, { status: 503, headers: responseHeaders });
  }
}
