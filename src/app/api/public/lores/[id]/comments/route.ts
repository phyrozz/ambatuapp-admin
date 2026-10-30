import { FieldPath, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { isDevLoreWriter } from '../../../../../../lib/dev-content-db';
import { createLoreComment, listLoreComments } from '../../../../../../lib/dev-lore-interactions';
import { encodeLoreCommentCursor, parseLoreCommentCursor } from '../../../../../../lib/lore-comment-cursor';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../../lib/firebase-admin';
import { playerFromRequest, requirePlayer } from '../../../../../../lib/player-auth';
import { fallbackPlayerName, playerDisplayProfiles } from '../../../../../../lib/player-profiles';

export const runtime = 'nodejs';
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!adminDb) return NextResponse.json({ error: 'Lore service is not configured.' }, { status: 503, headers });
  const { id } = await params;
  const url = new URL(request.url);
  let cursor;
  try { cursor = parseLoreCommentCursor(url.searchParams.get('cursor'), id); }
  catch { return NextResponse.json({ error: 'Invalid comment cursor.' }, { status: 400, headers }); }
  const requested = Number(url.searchParams.get('limit')) || 20;
  const limit = Math.min(50, Math.max(1, Math.floor(Number.isFinite(requested) ? requested : 20)));
  let playerId: string | null = null;
  if (request.headers.get('authorization')) {
    try { playerId = (await playerFromRequest(request))?.id ?? null; } catch {}
  }
  if (isDevLoreWriter()) {
    try {
      const result = await listLoreComments(id, playerId, url);
      return result ? NextResponse.json(result, { headers }) : NextResponse.json({ error: 'Lore not found.' }, { status: 404, headers });
    } catch { return NextResponse.json({ error: 'Lore service is not configured.' }, { status: 503, headers }); }
  }
  const lore = await adminDb.collection('lores').doc(id).get();
  if (!lore.exists || lore.data()?.status !== 'Published') return NextResponse.json({ error: 'Lore not found.' }, { status: 404, headers });
  let query = lore.ref.collection('comments').orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc').limit(limit + 1);
  if (cursor) {
    const time = cursor.time === null ? null : new Timestamp(Math.floor(Date.parse(cursor.time) / 1000), Number(cursor.time.slice(20, -1).padEnd(9, '0')));
    query = query.startAfter(time, cursor.id);
  }
  const snapshot = await query.get();
  const page = snapshot.docs.slice(0, limit);
  const profiles = await playerDisplayProfiles(
    page.map(doc => doc.data().authorId).filter((authorId): authorId is string => typeof authorId === 'string'),
    new Map(page.map(doc => [doc.data().authorId, doc.data().authorEmail ?? ''])),
  );
  const comments = await Promise.all(page.map(async doc => {
    const data = doc.data();
    const profile = typeof data.authorId === 'string' ? profiles.get(data.authorId) : undefined;
    const vote = playerId ? (await doc.ref.collection('votes').doc(playerId).get()).data()?.value ?? 0 : 0;
    return {
      id: doc.id,
      text: data.text,
      author: profile?.username ?? data.author ?? fallbackPlayerName(data.authorEmail ?? ''),
      avatarUrl: profile?.avatarUrl ?? null,
      authorId: data.authorId ?? null,
      parentId: typeof data.parentId === 'string' ? data.parentId : null,
      createdAt: data.createdAt?.toDate?.().toISOString() ?? null,
      upvotes: data.upvotes ?? 0,
      downvotes: data.downvotes ?? 0,
      userVote: vote,
    };
  }));
  const last = page.at(-1), timestamp = last?.data().createdAt;
  const time = timestamp instanceof Timestamp ? new Date(timestamp.seconds * 1000).toISOString().replace(/\.\d{3}Z$/, `.${String(timestamp.nanoseconds).padStart(9, '0')}Z`) : null;
  const nextCursor = snapshot.docs.length > limit && last ? encodeLoreCommentCursor({ v: 1, loreId: id, id: last.id, time }) : null;
  return NextResponse.json({ comments, nextCursor }, { headers });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!adminDb) throw new Error('Lore service is not configured.');
    const player = await requirePlayer(request);
    const { id } = await params;
    const { text, parentId } = await request.json();
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('Invalid comment.');
    if (parentId !== undefined && (typeof parentId !== 'string' || !parentId.trim())) throw new Error('Invalid reply target.');
    if (isDevLoreWriter()) return NextResponse.json(await createLoreComment(id, player, text, parentId ?? null), { status: 201, headers });
    const lore = adminDb.collection('lores').doc(id);
    const data = (await lore.get()).data();
    if (!data || data.status !== 'Published') throw new Error('Lore not found.');
    const commentsRef = lore.collection('comments');
    if (typeof parentId === 'string' && !(await commentsRef.doc(parentId).get()).exists) throw new Error('Comment not found.');
    const profile = (await playerDisplayProfiles([player.id], new Map([[player.id, player.email]]))).get(player.id);
    const author = profile?.username ?? fallbackPlayerName(player.email);
    const cleanText = text.trim();
    const ref = await commentsRef.add({ text: cleanText, author, authorId: player.id, authorEmail: player.email, parentId: parentId ?? null, upvotes: 0, downvotes: 0, createdAt: FieldValue.serverTimestamp() });
    await lore.update({ commentCount: FieldValue.increment(1) });
    return NextResponse.json({ id: ref.id, text: cleanText, author, avatarUrl: profile?.avatarUrl ?? null, authorId: player.id, parentId: parentId ?? null, createdAt: new Date().toISOString(), upvotes: 0, downvotes: 0, userVote: 0 }, { status: 201, headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Comment failed.' }, { status: 401, headers });
  }
}
