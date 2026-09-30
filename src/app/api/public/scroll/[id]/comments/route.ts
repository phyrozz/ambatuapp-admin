import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../../../lib/player-auth';
import { POST as postVideoComment } from '../../../videos/[id]/comments/route';
import { fallbackPlayerName, playerDisplayProfiles } from '../../../../../../lib/player-profiles';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try { await requirePlayer(request); } catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  return postVideoComment(request, context);
}
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let player;
  try { player = await requirePlayer(request); } catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  if (!adminDb) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers });
  const { id } = await params;
  const raw = new URL(request.url).searchParams.get('cursor');
  let cursor: { seconds: number; nanoseconds: number; id: string } | null = null;
  if (raw) {
    try {
      if (raw.length > 1024) throw new Error();
      cursor = JSON.parse(Buffer.from(raw, 'base64url').toString());
      if (!cursor || !Number.isSafeInteger(cursor.seconds) || cursor.seconds < 0 || cursor.seconds > 253402300799 || !Number.isInteger(cursor.nanoseconds) || cursor.nanoseconds < 0 || cursor.nanoseconds >= 1e9 || typeof cursor.id !== 'string' || !/^[\w-]{1,128}$/.test(cursor.id)) throw new Error();
    } catch { return NextResponse.json({ error: 'INVALID_CURSOR' }, { status: 400, headers }); }
  }
  try {
    const video = await adminDb.collection('videos').doc(id).get();
    if (video.data()?.status !== 'Published') return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404, headers });
    let query = video.ref.collection('comments').orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc').limit(21);
    if (cursor) query = query.startAfter(new Timestamp(cursor.seconds, cursor.nanoseconds), cursor.id);
    const snapshot = await query.get();
    const page = snapshot.docs.slice(0, 20);
    const profiles = await playerDisplayProfiles(page.map(doc => doc.data().authorId).filter((id): id is string => typeof id === 'string'), new Map(page.map(doc => [doc.data().authorId, doc.data().authorEmail ?? ''])));
    const comments = await Promise.all(page.map(async doc => {
      const data = doc.data();
      const profile = typeof data.authorEmail === 'string' && typeof data.authorId === 'string' ? profiles.get(data.authorId) : undefined;
      const vote = (await doc.ref.collection('votes').doc(`user:${player.id}`).get()).data()?.value;
      return { id: doc.id, text: data.text, author: profile?.username ?? data.author ?? fallbackPlayerName(data.authorEmail ?? ''), avatarUrl: profile?.avatarUrl ?? null, authorId: profile ? data.authorId : null, parentId: data.parentId ?? null, upvotes: data.upvotes ?? 0, downvotes: data.downvotes ?? 0, userVote: vote === 1 || vote === -1 ? vote : 0 };
    }));
    const last = page.at(-1);
    const time = last?.data().createdAt;
    return NextResponse.json({ comments, nextCursor: snapshot.size > 20 && last && time ? Buffer.from(JSON.stringify({ seconds: time.seconds, nanoseconds: time.nanoseconds, id: last.id })).toString('base64url') : null }, { headers });
  } catch { return NextResponse.json({ error: 'COMMENTS_UNAVAILABLE' }, { status: 500, headers }); }
}
