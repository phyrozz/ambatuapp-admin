import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../lib/firebase-admin';
import { signedVideoUrl } from '../../../../../lib/s3-videos';
import { fallbackPlayerName, playerDisplayProfiles } from '../../../../../lib/player-profiles';
import { playerFromRequest } from '../../../../../lib/player-auth';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!adminDb) return NextResponse.json({ error: 'Video service is not configured.' }, { status: 503, headers });
  const { id } = await params;
  const snapshot = await adminDb.collection('videos').doc(id).get();
  const data = snapshot.data();
  if (!data || data.status !== 'Published') return NextResponse.json({ error: 'Video not found.' }, { status: 404, headers });
  let userVote = 0;
  try {
    const player = await playerFromRequest(request);
    if (player) userVote = (await snapshot.ref.collection('votes').doc(`user:${player.id}`).get()).data()?.value ?? 0;
  } catch {}
  const profiles = typeof data.uploaderId === 'string' ? await playerDisplayProfiles([data.uploaderId], new Map([[data.uploaderId, data.uploaderEmail ?? '']])) : new Map();
  const profile = typeof data.uploaderId === 'string' ? profiles.get(data.uploaderId) : undefined;
  const uploader = profile?.username ?? (typeof data.uploaderId === 'string' ? data.uploaderName ?? fallbackPlayerName(data.uploaderEmail ?? '') : data.uploaderName ?? data.uploaderEmail);
  return NextResponse.json({ id, title: data.title, description: data.description ?? '', uploader, uploaderAvatarUrl: profile?.avatarUrl ?? null, uploaderId: data.uploaderId ?? null, videoUrl: await signedVideoUrl(data.videoKey), thumbnailUrl: typeof data.thumbnailKey === 'string' ? await signedVideoUrl(data.thumbnailKey) : '', upvotes: data.upvotes ?? 0, downvotes: data.downvotes ?? 0, commentCount: data.commentCount ?? 0, userVote }, { headers });
}
