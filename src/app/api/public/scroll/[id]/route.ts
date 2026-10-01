import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../../lib/player-auth';
import { fallbackPlayerName, playerDisplayProfiles } from '../../../../../lib/player-profiles';
import { signedVideoUrl } from '../../../../../lib/s3-videos';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' };

export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let player;
  try { player = await requirePlayer(request); }
  catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  if (!adminDb) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers });

  const { id } = await params;
  if (!/^[\w-]{1,128}$/.test(id)) return NextResponse.json({ error: 'VIDEO_NOT_FOUND' }, { status: 404, headers });

  try {
    const snapshot = await adminDb.collection('videos').doc(id).get();
    const data = snapshot.data();
    if (!data || data.status !== 'Published' || typeof data.videoKey !== 'string') {
      return NextResponse.json({ error: 'VIDEO_NOT_FOUND' }, { status: 404, headers });
    }

    const uploaderId = typeof data.uploaderId === 'string' && data.uploaderId !== 'admin' ? data.uploaderId : null;
    const profiles = uploaderId
      ? await playerDisplayProfiles([uploaderId], new Map([[uploaderId, data.uploaderEmail ?? '']]))
      : new Map();
    const profile = uploaderId ? profiles.get(uploaderId) : undefined;
    const vote = (await snapshot.ref.collection('votes').doc(`user:${player.id}`).get()).data()?.value;

    return NextResponse.json({
      id: snapshot.id,
      title: data.title,
      description: data.description ?? '',
      uploader: profile?.username ?? data.uploaderName ?? fallbackPlayerName(data.uploaderEmail ?? ''),
      uploaderId,
      uploaderAvatarUrl: profile?.avatarUrl ?? null,
      videoUrl: await signedVideoUrl(data.videoKey),
      thumbnailUrl: typeof data.thumbnailKey === 'string' ? await signedVideoUrl(data.thumbnailKey) : '',
      upvotes: data.upvotes ?? 0,
      downvotes: data.downvotes ?? 0,
      commentCount: data.commentCount ?? 0,
      userVote: vote === 1 || vote === -1 ? vote : 0,
    }, { headers });
  } catch {
    return NextResponse.json({ error: 'SCROLL_UNAVAILABLE' }, { status: 500, headers });
  }
}
