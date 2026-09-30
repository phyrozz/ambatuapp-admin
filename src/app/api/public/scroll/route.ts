import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../lib/player-auth';
import { signedVideoUrl } from '../../../../lib/s3-videos';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }
export async function GET(request: Request) {
  let player;
  try { player = await requirePlayer(request); } catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  if (!adminDb) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers });
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
    // Scan a bounded chronological batch. Filtering after the query avoids a new composite index.
    let query = adminDb.collection('videos').orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc').limit(9);
    if (cursor) query = query.startAfter(new Timestamp(cursor.seconds, cursor.nanoseconds), cursor.id);
    const snapshot = await query.get();
    const page = snapshot.docs.slice(0, 8);
    const videos = await Promise.all(page.filter(doc => doc.data().status === 'Published' && doc.data().videoKey).map(async doc => {
      const data = doc.data();
      const vote = (await doc.ref.collection('votes').doc(`user:${player.id}`).get()).data()?.value;
      return { id: doc.id, title: data.title, description: data.description ?? '', videoUrl: await signedVideoUrl(data.videoKey), thumbnailUrl: await signedVideoUrl(data.thumbnailKey), upvotes: data.upvotes ?? 0, downvotes: data.downvotes ?? 0, commentCount: data.commentCount ?? 0, userVote: vote === 1 || vote === -1 ? vote : 0 };
    }));
    const last = page.at(-1);
    const time = last?.data().createdAt;
    const nextCursor = snapshot.size > 8 && last && time ? Buffer.from(JSON.stringify({ seconds: time.seconds, nanoseconds: time.nanoseconds, id: last.id })).toString('base64url') : null;
    return NextResponse.json({ videos, nextCursor }, { headers });
  } catch { return NextResponse.json({ error: 'SCROLL_UNAVAILABLE' }, { status: 500, headers }); }
}
