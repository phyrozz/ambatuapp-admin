import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../lib/firebase-admin';
import { signedVideoUrl } from '../../../../../lib/s3-videos';
import { fallbackPlayerName, playerNames } from '../../../../../lib/player-profiles';

const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!adminDb) return NextResponse.json({ error: 'Video service is not configured.' }, { status: 503, headers });
  const { id } = await params;
  const snapshot = await adminDb.collection('videos').doc(id).get();
  const data = snapshot.data();
  if (!data || data.status !== 'Published') return NextResponse.json({ error: 'Video not found.' }, { status: 404, headers });
  const names = typeof data.uploaderId === 'string' ? await playerNames([data.uploaderId], new Map([[data.uploaderId, data.uploaderEmail ?? '']])) : new Map<string, string>();
  const uploader = typeof data.uploaderId === 'string' ? names.get(data.uploaderId) ?? data.uploaderName ?? fallbackPlayerName(data.uploaderEmail ?? '') : data.uploaderName ?? data.uploaderEmail;
  return NextResponse.json({ id, title: data.title, description: data.description ?? '', uploader, videoUrl: await signedVideoUrl(data.videoKey), upvotes: data.upvotes ?? 0, downvotes: data.downvotes ?? 0, commentCount: data.commentCount ?? 0 }, { headers });
}
