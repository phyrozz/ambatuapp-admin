import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withDreamDb } from './dev-content-db';
import { dreamBody, dreamCursor, DreamError } from './dream-validation';

type DreamRow = { id: string; author_id: string; body: string; audience: 'public' | 'friends' | 'only_me'; publication: string; revision: number; created_at: Date; updated_at: Date; published_at: Date | null; username: string | null; cursor_time?: string };
const selection = `SELECT d.*,p.username FROM app.dreams d LEFT JOIN app.player_profiles p ON p.id=d.author_id`;
const eligible = `NOT EXISTS (SELECT 1 FROM app.player_deletions WHERE player_id=d.author_id OR player_id=$2)
  AND NOT EXISTS (SELECT 1 FROM app.player_blocks WHERE (blocker_id=$2 AND blocked_id=d.author_id) OR (blocker_id=d.author_id AND blocked_id=$2))
  AND (d.author_id=$2 OR (d.publication='published' AND d.moderation='visible' AND (d.audience='public' OR
    (d.audience='friends' AND EXISTS (SELECT 1 FROM app.friendships WHERE player_id=$2 AND other_player_id=d.author_id AND state='accepted')
      AND EXISTS (SELECT 1 FROM app.friendships WHERE player_id=d.author_id AND other_player_id=$2 AND state='accepted')))))`;
function dto(row: DreamRow) {
  return { id: row.id, authorId: row.author_id, authorName: row.username, text: row.body, audience: row.audience, publication: row.publication, revision: row.revision,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), publishedAt: row.published_at?.toISOString() ?? null };
}
async function read(db: PoolClient, id: string, viewer: string | null) {
  const row = (await db.query<DreamRow>(`${selection} WHERE d.id=$1 AND ${eligible}`, [id, viewer])).rows[0];
  if (!row) throw new DreamError('DREAM_UNAVAILABLE', 404);
  return dto(row);
}
async function lockAuthor(db: PoolClient, author: string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`dream-author:${author}`]);
  if ((await db.query('SELECT 1 FROM app.player_deletions WHERE player_id=$1', [author])).rowCount) throw new DreamError('ACCOUNT_UNAVAILABLE', 403);
}
export function getDream(id: string, viewer: string | null) { return withDreamDb(db => read(db, id, viewer)); }
export async function createDream(author: string, value: unknown, key: string) {
  const body = dreamBody(value), text = body.text!, audience = body.audience ?? 'public', publication = body.publish === false ? 'draft' : 'published';
  const hash = createHash('sha256').update(JSON.stringify({ text, audience, publication })).digest('hex');
  return withDreamDb(async db => {
    await lockAuthor(db, author);
    const prior = (await db.query<{ request_hash: string | null; dream_id: string | null }>('SELECT request_hash,dream_id FROM app.dream_requests WHERE author_id=$1 AND request_key=$2', [author, key])).rows[0];
    if (prior) {
      if (!prior.dream_id) throw new DreamError('DREAM_UNAVAILABLE', 410);
      if (prior.request_hash !== hash) throw new DreamError('IDEMPOTENCY_CONFLICT', 409);
      return read(db, prior.dream_id, author);
    }
    const id = randomUUID();
    await db.query("INSERT INTO app.dreams (id,author_id,body,audience,publication,published_at) VALUES ($1,$2,$3,$4,$5,CASE WHEN $5='published' THEN now() ELSE NULL END)", [id, author, text, audience, publication]);
    await db.query('INSERT INTO app.dream_requests (author_id,request_key,request_hash,dream_id) VALUES ($1,$2,$3,$4)', [author, key, hash, id]);
    return read(db, id, author);
  });
}
export async function editDream(id: string, author: string, value: unknown) {
  const body = dreamBody(value, true);
  return withDreamDb(async db => {
    await lockAuthor(db, author);
    const current = (await db.query<DreamRow>('SELECT * FROM app.dreams WHERE id=$1 AND author_id=$2 FOR UPDATE', [id, author])).rows[0];
    if (!current) throw new DreamError('DREAM_UNAVAILABLE', 404);
    if (current.revision !== body.revision) throw new DreamError('REVISION_CONFLICT', 409);
    const publication = body.publish === undefined ? current.publication : body.publish ? 'published' : 'draft';
    await db.query(`UPDATE app.dreams SET body=$3,audience=$4,publication=$5,revision=revision+1,updated_at=now(),
      published_at=CASE WHEN $5='published' THEN coalesce(published_at,now()) ELSE published_at END WHERE id=$1 AND author_id=$2`, [id, author, body.text ?? current.body, body.audience ?? current.audience, publication]);
    return read(db, id, author);
  });
}
export function deleteDream(id: string, author: string) {
  return withDreamDb(async db => {
    await lockAuthor(db, author);
    const row = (await db.query('SELECT id FROM app.dreams WHERE id=$1 AND author_id=$2 FOR UPDATE', [id, author])).rows[0];
    if (!row) throw new DreamError('DREAM_UNAVAILABLE', 404);
    await db.query('UPDATE app.dream_requests SET dream_id=NULL,request_hash=NULL WHERE dream_id=$1 AND author_id=$2', [id, author]);
    await db.query('DELETE FROM app.dreams WHERE id=$1 AND author_id=$2', [id, author]);
  });
}
export async function myDreams(author: string, raw: string | null) {
  const cursor = dreamCursor(raw, author);
  return withDreamDb(async db => {
    if ((await db.query('SELECT 1 FROM app.player_deletions WHERE player_id=$1', [author])).rowCount) throw new DreamError('ACCOUNT_UNAVAILABLE', 403);
    const result = await db.query<DreamRow>(`SELECT d.*,p.username,to_char(d.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
      FROM app.dreams d LEFT JOIN app.player_profiles p ON p.id=d.author_id WHERE d.author_id=$1
      AND ($2::timestamptz IS NULL OR (d.created_at,d.id)<($2::timestamptz,$3::uuid)) ORDER BY d.created_at DESC,d.id DESC LIMIT 13`, [author, cursor?.time ?? null, cursor?.id ?? null]);
    const page = result.rows.slice(0, 12), last = page.at(-1);
    return { dreams: page.map(dto), nextCursor: result.rows.length > 12 && last ? Buffer.from(JSON.stringify({ v: 1, owner: author, time: last.cursor_time, id: last.id })).toString('base64url') : null };
  });
}
/** Server-only integration hook. Full account deletion is delivered in phase 7. */
export function beginPlayerDreamDeletion(author: string) {
  return withDreamDb(async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`dream-author:${author}`]);
    await db.query("INSERT INTO app.player_deletions (player_id,state) VALUES ($1,'pending') ON CONFLICT (player_id) DO NOTHING", [author]);
    await db.query('DELETE FROM app.dream_requests WHERE author_id=$1', [author]);
    await db.query('DELETE FROM app.dreams WHERE author_id=$1', [author]);
  });
}
