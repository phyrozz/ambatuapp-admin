import { NextResponse } from 'next/server';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { requireAdmin } from '../../../../lib/api-auth';
import { studioError } from '../../../../lib/studio-api';
import { canAccess } from '../../../../lib/studio-policy.mjs';
import { isDevCharacterWriter, isDevLoreWriter, isDevVideoWriter, isDevSoundWriter, isDevSocialWriter, isDevProfileWriter, withDevContentDb, withDevSocialDb, withDevVideoDb, withDevProfileDb } from '../../../../lib/dev-content-db';

const day = 86400000;
const offset = 8 * 3600000;
const kinds = [
  { kind: 'character', module: 'characters', postgres: isDevCharacterWriter },
  { kind: 'lore', module: 'lores', postgres: isDevLoreWriter },
  { kind: 'video', module: 'videos', postgres: isDevVideoWriter },
  { kind: 'sound', module: 'sounds', postgres: isDevSoundWriter },
] as const;

async function contentStats(item: typeof kinds[number], today: number) {
  if (item.postgres()) return withDevContentDb(async db => {
    const result = await db.query<{ status: string | null; created_at: string | null; n: number }>(`SELECT status, to_char(created_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD') AS created_at, count(*)::int AS n FROM app.content WHERE kind=$1 GROUP BY status, to_char(created_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD')`, [item.kind]);
    const trend = Array(14).fill(0) as number[];
    let published = 0, draft = 0, other = 0;
    for (const row of result.rows) {
      if (row.status === 'Published') published += row.n;
      else if (row.status === 'Draft') draft += row.n;
      else other += row.n;
      // Grouping uses Philippine calendar dates.
      if (row.created_at) {
        const date = row.created_at;
        const index = Math.round((Date.parse(`${date}T00:00:00Z`) - (today + offset - 14 * day)) / day);
        if (index >= 0 && index < 14) trend[index] += row.n;
      }
    }
    return { kind: item.kind, published, draft, other, trend };
  });
  throw new Error('unavailable');
}

async function popular(item: typeof kinds[number]) {
  if (item.kind === 'sound') return [];
  if (item.postgres()) return withDevContentDb(async db => (await db.query<{ title: string | null; votes: number }>(`SELECT CASE c.kind WHEN 'character' THEN ch.name WHEN 'lore' THEN l.title WHEN 'video' THEN v.title END AS title, c.upvotes::int AS votes
    FROM app.content c LEFT JOIN app.characters ch ON c.kind='character' AND ch.id=c.id LEFT JOIN app.lores l ON c.kind='lore' AND l.id=c.id LEFT JOIN app.videos v ON c.kind='video' AND v.id=c.id
    WHERE c.kind=$1 AND c.status='Published' AND c.upvotes>0 ORDER BY c.upvotes DESC,c.id LIMIT 5`, [item.kind])).rows.map(row => ({ ...row, kind: item.kind })));
  throw new Error('unavailable');
}

async function community(type: 'comments' | 'follows', today: number) {
  const start = today - 14 * day;
  if (type === 'follows' && isDevSocialWriter()) return withDevSocialDb(async db => (await db.query<{ recent: number; previous: number }>(`SELECT count(*) FILTER (WHERE created_at >= $2)::int AS recent, count(*) FILTER (WHERE created_at < $2)::int AS previous FROM app.follows WHERE created_at >= $1 AND created_at < $3`, [new Date(start), new Date(today - 7 * day), new Date(today)])).rows[0]);
  if (type === 'comments' && (isDevVideoWriter() || isDevLoreWriter())) {
    // Mixed backends cannot provide a complete community total.
    if (!isDevVideoWriter() || !isDevLoreWriter()) throw new Error('unavailable');
    const query = async (db: import('pg').PoolClient) => (await db.query<{ recent: number; previous: number }>(`SELECT count(*) FILTER (WHERE created_at >= $2)::int AS recent, count(*) FILTER (WHERE created_at < $2)::int AS previous FROM app.comments WHERE created_at >= $1 AND created_at < $3`, [new Date(start), new Date(today - 7 * day), new Date(today)])).rows[0];
    return withDevVideoDb(query);
  }
  throw new Error('unavailable');
}

async function pendingAvatars() {
  if (isDevProfileWriter()) return withDevProfileDb(async db => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM app.avatar_moderation WHERE status='pending'")).rows[0].n);
  throw new Error('unavailable');
}
async function openReports() {
  if (!process.env.CHAT_TABLE) throw new Error('unavailable');
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ap-southeast-1' }));
  let cursor: Record<string, unknown> | undefined, total = 0;
  do {
    const result = await client.send(new ScanCommand({ TableName: process.env.CHAT_TABLE, FilterExpression: 'begins_with(pk, :report) AND (attribute_not_exists(#status) OR #status <> :resolved)', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':report': 'REPORT#', ':resolved': 'resolved' }, Select: 'COUNT', ExclusiveStartKey: cursor }));
    total += result.Count ?? 0;
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return total;
}

export async function GET(request: Request) {
  try {
    const actor = await requireAdmin(request, { module: 'dashboard', action: 'view' });
    // Existing content endpoints restrict non-root users to their own records.
    if (actor && actor.roleId !== 'root') return NextResponse.json({ restricted: true }, { headers: { 'Cache-Control': 'no-store' } });
    const allowed = (module: typeof kinds[number]['module'] | 'profile-avatars' | 'chat-reports') => !actor || canAccess(actor.permissions, module, 'view');
    const today = Math.floor((Date.now() + offset) / day) * day - offset;
    const settle = async <T,>(promise: Promise<T>) => promise.catch(() => null);
    const [content, top, comments, follows, avatars, reports] = await Promise.all([
      Promise.all(kinds.filter(item => allowed(item.module)).map(item => settle(contentStats(item, today)))),
      Promise.all(kinds.filter(item => item.kind !== 'sound' && allowed(item.module)).map(item => settle(popular(item)))),
      settle(community('comments', today)), settle(community('follows', today)),
      allowed('profile-avatars') ? settle(pendingAvatars()) : null,
      allowed('chat-reports') ? settle(openReports()) : null,
    ]);
    return NextResponse.json({ content, top, comments, follows, avatars, reports, dates: Array.from({ length: 14 }, (_, i) => new Date(today + offset - (14 - i) * day).toISOString().slice(0, 10)) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return studioError(error); }
}
