import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { withDevVideoDb } from './dev-content-db';
import { signedVideoUrl, videoBucket, videoClient } from './s3-videos';

export type ScrollAd = { id: string; title: string; imageUrl: string; destinationUrl: string; active: boolean };
const prefix = 'scroll-ads/';
const limit = 3 * 1024 * 1024;
function url(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter a valid HTTPS URL.');
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error();
    return parsed.href;
  } catch { throw new Error('Enter a valid HTTPS URL.'); }
}
export function adFields(body: Record<string, unknown>) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title || title.length > 120 || typeof body.active !== 'boolean') throw new Error('Enter a title and status.');
  return { title, imageUrl: url(body.imageUrl), destinationUrl: url(body.destinationUrl), active: body.active };
}
export function formFields(form: FormData) {
  const title = String(form.get('title') ?? '').trim();
  if (!title || title.length > 120) throw new Error('Enter a title up to 120 characters.');
  const active = form.get('active');
  if (active !== 'true' && active !== 'false') throw new Error('Choose a status.');
  return { title, destinationUrl: url(form.get('destinationUrl')), active: active === 'true' };
}
export async function uploadAdImage(file: File) {
  if (!file.size || file.size > limit) throw new Error('Choose an image no larger than 3 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const png = file.type === 'image/png' && bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v,i) => bytes[i] === v);
  const jpg = file.type === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = file.type === 'image/webp' && bytes.length >= 12 && String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP';
  if (!png && !jpg && !webp) throw new Error('Choose a valid PNG, JPG, or WebP image.');
  const bucket = videoBucket();
  if (!bucket) throw new Error('Image storage is not configured.');
  const key = `${prefix}${randomUUID()}.${png ? 'png' : jpg ? 'jpg' : 'webp'}`;
  await videoClient().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: file.type, CacheControl: 'public, max-age=31536000, immutable' }));
  return key;
}
export async function deleteAdImage(key: string | null | undefined) {
  if (!key?.startsWith(prefix)) return;
  try { const bucket = videoBucket(); if (bucket) await videoClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); }
  catch { /* Unreferenced objects may be cleaned up later. */ }
}
async function hydrate(ad: ScrollAd): Promise<ScrollAd> {
  return { ...ad, imageUrl: ad.imageUrl.startsWith(prefix) ? await signedVideoUrl(ad.imageUrl) : ad.imageUrl };
}
const columns = 'id,title,image_url AS "imageUrl",destination_url AS "destinationUrl",active';
export async function listAds(cursor: string | null) {
  if (cursor && !/^[0-9a-f-]{36}$/.test(cursor)) throw new Error('Invalid cursor.');
  const rows = await withDevVideoDb(async db => (await db.query<ScrollAd>(`SELECT ${columns} FROM app.scroll_ads WHERE ($1::text IS NULL OR id > $1) ORDER BY id LIMIT 21`, [cursor])).rows);
  return { ads: await Promise.all(rows.slice(0, 20).map(hydrate)), nextCursor: rows.length > 20 ? rows[19].id : null };
}
export async function createAd(fields: ReturnType<typeof adFields>) {
  const row = await withDevVideoDb(async db => (await db.query<ScrollAd>(`INSERT INTO app.scroll_ads (id,title,image_url,destination_url,active) VALUES ($1,$2,$3,$4,$5) RETURNING ${columns}`, [randomUUID(), fields.title, fields.imageUrl, fields.destinationUrl, fields.active])).rows[0]);
  return hydrate(row);
}
export async function createUploadedAd(fields: ReturnType<typeof formFields>, key: string) {
  const row = await withDevVideoDb(async db => (await db.query<ScrollAd>(`INSERT INTO app.scroll_ads (id,title,image_url,destination_url,active) VALUES ($1,$2,$3,$4,$5) RETURNING ${columns}`, [randomUUID(), fields.title, key, fields.destinationUrl, fields.active])).rows[0]);
  return row;
}
export async function updateAd(id: string, fields: ReturnType<typeof adFields>) {
  const row = await withDevVideoDb(async db => (await db.query<ScrollAd>(`UPDATE app.scroll_ads SET title=$2,image_url=$3,destination_url=$4,active=$5,updated_at=now() WHERE id=$1 RETURNING ${columns}`, [id, fields.title, fields.imageUrl, fields.destinationUrl, fields.active])).rows[0] ?? null);
  return row ? hydrate(row) : null;
}
export async function updateUploadedAd(id: string, fields: ReturnType<typeof formFields>, key: string | null) {
  const result = await withDevVideoDb(async db => {
    const prior = (await db.query<{image_url: string}>('SELECT image_url FROM app.scroll_ads WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!prior) return null;
    const row = (await db.query<ScrollAd>(`UPDATE app.scroll_ads SET title=$2,image_url=$3,destination_url=$4,active=$5,updated_at=now() WHERE id=$1 RETURNING ${columns}`, [id, fields.title, key ?? prior.image_url, fields.destinationUrl, fields.active])).rows[0];
    return { row, previous: key ? prior.image_url : null };
  });
  return result;
}
export async function deleteAd(id: string) {
  const row = await withDevVideoDb(async db => (await db.query<{image_url: string}>('DELETE FROM app.scroll_ads WHERE id=$1 RETURNING image_url', [id])).rows[0]);
  if (row) await deleteAdImage(row.image_url);
  return !!row;
}
export async function hydrateAd(ad: ScrollAd) { return hydrate(ad); }
export async function randomAd() {
  const row = await withDevVideoDb(async db => (await db.query<ScrollAd>(`SELECT ${columns} FROM app.scroll_ads WHERE active ORDER BY random() LIMIT 1`)).rows[0] ?? null);
  return row ? hydrate(row) : null;
}
