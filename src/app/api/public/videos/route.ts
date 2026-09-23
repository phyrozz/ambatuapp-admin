import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../lib/player-auth';
import { signedVideoUrl } from '../../../../lib/s3-videos';
import { fallbackPlayerName, playerNames } from '../../../../lib/player-profiles';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function GET(request: Request) {
  if (!adminDb) return NextResponse.json({ error: 'Video service is not configured.' }, { status: 503, headers });
  const url = new URL(request.url);
  const limit = Math.min(18, Math.max(1, Number(url.searchParams.get('limit')) || 8));
  const sort = url.searchParams.get('sort');
  if (sort === 'upvotes') {
    const snapshot = await adminDb.collection('videos').where('status', '==', 'Published').get();
    const page = snapshot.docs.sort((a, b) => (b.data().upvotes ?? 0) - (a.data().upvotes ?? 0)).slice(0, limit);
    const names = await playerNames(page.map(doc => doc.data().uploaderId).filter((id): id is string => typeof id === 'string'), new Map(page.map(doc => [doc.data().uploaderId, doc.data().uploaderEmail ?? ''])));
    const videos = await Promise.all(page.map(async doc => { const data = doc.data(); return { id: doc.id, title: data.title, description: data.description ?? '', uploader: typeof data.uploaderId === 'string' ? names.get(data.uploaderId) ?? data.uploaderName ?? fallbackPlayerName(data.uploaderEmail ?? '') : data.uploaderName ?? data.uploaderEmail, uploaderId: data.uploaderId ?? null, thumbnailUrl: await signedVideoUrl(data.thumbnailKey), upvotes: data.upvotes ?? 0, downvotes: data.downvotes ?? 0, commentCount: data.commentCount ?? 0, createdAt: data.createdAt?.toDate?.().toISOString() ?? null }; }));
    return NextResponse.json({ videos, nextCursor: null }, { headers });
  }
  const cursor = Number(url.searchParams.get('cursor'));
  let query = adminDb.collection('videos').orderBy('createdAt', 'desc').limit(limit + 1);
  if (Number.isFinite(cursor) && cursor > 0) query = query.startAfter(new Date(cursor));
  const snapshot = await query.get();
  const page = snapshot.docs.slice(0, limit);
  const names = await playerNames(page.map((doc) => doc.data().uploaderId).filter((id): id is string => typeof id === 'string'), new Map(page.map((doc) => [doc.data().uploaderId, doc.data().uploaderEmail ?? ''])));
  const videos = await Promise.all(page.filter(doc => doc.data().status === 'Published').map(async doc => {
    const data = doc.data();
    return { id: doc.id, title: data.title, description: data.description ?? '', uploader: typeof data.uploaderId === 'string' ? names.get(data.uploaderId) ?? data.uploaderName ?? fallbackPlayerName(data.uploaderEmail ?? '') : data.uploaderName ?? data.uploaderEmail, uploaderId: data.uploaderId ?? null, thumbnailUrl: await signedVideoUrl(data.thumbnailKey), upvotes: data.upvotes ?? 0, downvotes: data.downvotes ?? 0, commentCount: data.commentCount ?? 0, createdAt: data.createdAt?.toDate?.().toISOString() ?? null };
  }));
  const last = page.at(-1)?.data().createdAt;
  return NextResponse.json({ videos, nextCursor: snapshot.docs.length > limit && last?.toMillis ? last.toMillis() : null }, { headers });
}

export async function POST(request: Request) {
  try {
    if (!adminDb) throw new Error('Video service is not configured.');
    const player = await requirePlayer(request);
    const { title, description, videoKey, thumbnailKey } = await request.json();
    if (typeof title !== 'string' || !title.trim() || title.length > 120) throw new Error('Enter a title up to 120 characters.');
    if (typeof description !== 'string' || description.length > 1000) throw new Error('Description is too long.');
    if (typeof videoKey !== 'string' || !videoKey.startsWith(`videos/${player.id}/`)) throw new Error('Invalid video upload.');
    if (typeof thumbnailKey !== 'string' || !thumbnailKey.startsWith(`video-thumbnails/${player.id}/`)) throw new Error('Invalid video thumbnail.');
    const names = await playerNames([player.id], new Map([[player.id, player.email]]));
    const data = { title: title.trim(), description: description.trim(), videoKey, thumbnailKey, uploaderEmail: player.email, uploaderName: names.get(player.id) ?? fallbackPlayerName(player.email), uploaderId: player.id, status: 'Published', upvotes: 0, downvotes: 0, commentCount: 0, createdAt: FieldValue.serverTimestamp() };
    const ref = await adminDb.collection('videos').add(data);
    return NextResponse.json({ id: ref.id, ...data, createdAt: new Date().toISOString(), thumbnailUrl: await signedVideoUrl(thumbnailKey) }, { status: 201, headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not publish video.' }, { status: 400, headers });
  }
}
