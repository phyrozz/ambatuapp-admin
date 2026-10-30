import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { isDevVideoWriter } from '../../../../../../lib/dev-content-db';
import { listCreatorClips } from '../../../../../../lib/dev-videos';
import { adminDb } from '../../../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../../../lib/player-auth';
import { validFriendId } from '../../../../../../lib/friend-list';
import { creatorHeaders as headers } from '../../../../../../lib/creator-profile';
import { signedVideoUrl } from '../../../../../../lib/s3-videos';

export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let player;
  try { player = await requirePlayer(request); } catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  const { id } = await params;
  if (!validFriendId(id) || id === 'admin') return NextResponse.json({ error: 'PLAYER_NOT_FOUND' }, { status: 404, headers });
  const db = adminDb;
  if (!db) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers });
  const own = id === player.id;
  const raw = new URL(request.url).searchParams.get('cursor');
  if (isDevVideoWriter()) {
    try { return NextResponse.json(await listCreatorClips(id, player.id, raw), { headers }); }
    catch (error) { return NextResponse.json({ error: error instanceof Error && error.message === 'INVALID_CURSOR' ? 'INVALID_CURSOR' : 'CLIPS_UNAVAILABLE' }, { status: error instanceof Error && error.message === 'INVALID_CURSOR' ? 400 : 500, headers }); }
  }
  let cursor: { owner: string; own: boolean; seconds: number; nanoseconds: number; id: string } | null = null;
  if (raw) {
    try {
      if (raw.length > 1024) throw new Error();
      cursor = JSON.parse(Buffer.from(raw, 'base64url').toString());
      if (!cursor || cursor.owner !== id || cursor.own !== own || !validFriendId(cursor.id) || !Number.isSafeInteger(cursor.seconds) || cursor.seconds < 0 || cursor.seconds > 253402300799 || !Number.isInteger(cursor.nanoseconds) || cursor.nanoseconds < 0 || cursor.nanoseconds >= 1e9) throw new Error();
    } catch { return NextResponse.json({ error: 'INVALID_CURSOR' }, { status: 400, headers }); }
  }
  try {
    let query = db.collection('videos').where('uploaderId', '==', id);
    if (!own) query = query.where('status', '==', 'Published');
    query = query.orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc').limit(13);
    if (cursor) query = query.startAfter(new Timestamp(cursor.seconds, cursor.nanoseconds), cursor.id);
    const snapshot = await query.get();
    const page = snapshot.docs.slice(0, 12);
    const clips = await Promise.all(page.map(async doc => {
      const data = doc.data();
      return {
        id: doc.id, title: typeof data.title === 'string' ? data.title : '', description: typeof data.description === 'string' ? data.description : '',
        thumbnailUrl: typeof data.thumbnailKey === 'string' ? await signedVideoUrl(data.thumbnailKey) : null,
        status: data.status === 'Published' ? 'Published' : 'Draft', playable: data.status === 'Published' && typeof data.videoKey === 'string' && !!data.videoKey,
        createdAt: data.createdAt?.toDate?.().toISOString() ?? null,
        upvotes: data.upvotes ?? 0, commentCount: data.commentCount ?? 0,
      };
    }));
    const last = page.at(-1);
    const time = last?.data().createdAt;
    const nextCursor = snapshot.size > 12 && last && time ? Buffer.from(JSON.stringify({ owner:id, own, seconds:time.seconds, nanoseconds:time.nanoseconds, id:last.id })).toString('base64url') : null;
    return NextResponse.json({ clips, nextCursor }, { headers });
  } catch { return NextResponse.json({ error: 'CLIPS_UNAVAILABLE' }, { status: 500, headers }); }
}
