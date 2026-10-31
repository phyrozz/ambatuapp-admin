import { FieldPath, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { isDevVideoWriter } from '../../../../../../lib/dev-content-db';
import { createVideoComment, listVideoComments } from '../../../../../../lib/dev-video-interactions';
import { encodeLoreCommentCursor, parseLoreCommentCursor } from '../../../../../../lib/lore-comment-cursor';
import { adminDb } from '../../../../../../lib/firebase-admin';
import { playerFromRequest, requirePlayer } from '../../../../../../lib/player-auth';
import { fallbackPlayerName, playerDisplayProfiles } from '../../../../../../lib/player-profiles';
import { allowPlayerWrite } from '../../../../../../lib/public-write-limits';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!adminDb && !isDevVideoWriter()) return NextResponse.json({ error: 'Video service is not configured.' }, { status: 503, headers });
  const { id } = await params;
  const url = new URL(request.url);
  let cursor;
  try { cursor = parseLoreCommentCursor(url.searchParams.get('cursor'), `video:${id}`); }
  catch { return NextResponse.json({ error: 'Invalid comment cursor.' }, { status: 400, headers }); }
  const requested = Number(url.searchParams.get('limit')) || 20;
  const limit = Math.min(50, Math.max(1, Math.floor(Number.isFinite(requested) ? requested : 20)));
  let playerId: string | null = null;
  try { playerId = (await playerFromRequest(request))?.id ?? null; } catch {}
  if (isDevVideoWriter()) {
    try {
      const result = await listVideoComments(id, playerId, url);
      return result ? NextResponse.json(result, { headers }) : NextResponse.json({ error: 'Video not found.' }, { status: 404, headers });
    } catch { return NextResponse.json({ error: 'Video service is not configured.' }, { status: 503, headers }); }
  }
  const video = await adminDb!.collection('videos').doc(id).get();
  if (!video.exists || video.data()?.status !== 'Published') return NextResponse.json({ error: 'Video not found.' }, { status: 404, headers });
  let query = video.ref.collection('comments').orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc').limit(limit + 1);
  if (cursor) query = query.startAfter(cursor.time === null ? null : new Timestamp(Math.floor(Date.parse(cursor.time) / 1000), Number(cursor.time.slice(20, -1).padEnd(9, '0'))), cursor.id);
  const snapshot = await query.get();
  const page = snapshot.docs.slice(0, limit);
  const voterId = playerId ? `user:${playerId}` : null;
  const profiles = await playerDisplayProfiles(
    page.map(doc => doc.data().authorId).filter((authorId, index): authorId is string => typeof authorId === 'string' && typeof page[index].data().authorEmail === 'string'),
    new Map(page.map(doc => [doc.data().authorId, doc.data().authorEmail ?? ''])),
  );
  const comments = await Promise.all(page.map(async doc => {
    const data = doc.data();
    const profile = typeof data.authorId === 'string' ? profiles.get(data.authorId) : undefined;
    const vote = voterId ? (await doc.ref.collection('votes').doc(voterId).get()).data()?.value ?? 0 : 0;
    return {
      id: doc.id,
      text: data.text,
      author: typeof data.authorEmail === 'string' ? profile?.username ?? data.author ?? fallbackPlayerName(data.authorEmail) : data.author ?? 'Anonymous',
      avatarUrl: profile?.avatarUrl ?? null,
      authorId: data.authorEmail ? data.authorId : null,
      parentId: typeof data.parentId === 'string' ? data.parentId : null,
      createdAt: data.createdAt?.toDate?.().toISOString() ?? null,
      upvotes: data.upvotes ?? 0,
      downvotes: data.downvotes ?? 0,
      userVote: vote,
    };
  }));
  const last = page.at(-1), timestamp = last?.data().createdAt;
  const time = timestamp instanceof Timestamp ? new Date(timestamp.seconds * 1000).toISOString().replace(/\.\d{3}Z$/, `.${String(timestamp.nanoseconds).padStart(9, '0')}Z`) : null;
  const nextCursor = snapshot.docs.length > limit && last ? encodeLoreCommentCursor({ v: 1, loreId: `video:${id}`, id: last.id, time }) : null;
  return NextResponse.json({ comments, nextCursor }, { headers });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let player: Awaited<ReturnType<typeof requirePlayer>>;
  try {
    player = await requirePlayer(request);
  } catch {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers });
  }

  try {
    if (!adminDb && !isDevVideoWriter()) throw new Error('Video service is not configured.');
    const { id } = await params;
    const { text, parentId } = await request.json();
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('Invalid comment.');
    if (parentId !== undefined && (typeof parentId !== 'string' || !parentId.trim())) throw new Error('Invalid reply target.');
    if (!await allowPlayerWrite(adminDb, player.id, 'videoComments', [
      { key: 'minute', max: 5, windowMs: 60_000 },
      { key: 'hour', max: 30, windowMs: 60 * 60_000 },
    ])) return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429, headers });
    if (isDevVideoWriter()) return NextResponse.json(await createVideoComment(id, player, text, parentId ?? null), { status: 201, headers });
    const video = adminDb!.collection('videos').doc(id);
    const data = (await video.get()).data();
    if (!data || data.status !== 'Published') throw new Error('Video not found.');
    const commentsRef = video.collection('comments');
    if (typeof parentId === 'string' && !(await commentsRef.doc(parentId).get()).exists) throw new Error('Comment not found.');
    const profile = player ? (await playerDisplayProfiles([player.id], new Map([[player.id, player.email]]))).get(player.id) : undefined;
    const author = profile?.username ?? fallbackPlayerName(player.email);
    const cleanText = text.trim();
    const ref = await commentsRef.add({ text: cleanText, author, authorEmail: player.email, authorId: player.id, parentId: parentId ?? null, upvotes: 0, downvotes: 0, createdAt: FieldValue.serverTimestamp() });
    await video.update({ commentCount: FieldValue.increment(1) });
    return NextResponse.json({ id: ref.id, text: cleanText, author, avatarUrl: profile?.avatarUrl ?? null, authorId: player.id, parentId: parentId ?? null, createdAt: new Date().toISOString(), upvotes: 0, downvotes: 0, userVote: 0 }, { status: 201, headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Comment failed.' }, { status: 400, headers });
  }
}
