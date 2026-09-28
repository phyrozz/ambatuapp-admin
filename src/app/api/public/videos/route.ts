import { FieldPath, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../lib/player-auth';
import { signedVideoUrl } from '../../../../lib/s3-videos';
import { fallbackPlayerName, playerDisplayProfiles } from '../../../../lib/player-profiles';
import { headVideoObject, VIDEO_COMPRESSION_VERSION } from '../../../../lib/video-transcoding.mjs';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

const RELEVANCE_BOOST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RELEVANCE_BOOST_POINTS = 5;

type TimestampCursor = { seconds: number; nanoseconds: number; id: string };
type PopularCursor = TimestampCursor & { upvotes: number; commentCount: number };
type RelevanceFeedCursor = { version: 1; asOf: number; popular: PopularCursor | null; fresh: TimestampCursor | null; freshDone: boolean };

function timestampCursor(doc: { id: string; data: () => { createdAt?: { seconds?: number; nanoseconds?: number } } }): TimestampCursor | null {
  const data = doc.data();
  const createdAt = data.createdAt;
  if (!Number.isSafeInteger(createdAt?.seconds) || !Number.isInteger(createdAt?.nanoseconds)) return null;
  return { seconds: createdAt.seconds!, nanoseconds: createdAt.nanoseconds!, id: doc.id };
}

function popularCursor(doc: { id: string; data: () => { upvotes?: number; commentCount?: number; createdAt?: { seconds?: number; nanoseconds?: number } } }): PopularCursor | null {
  const time = timestampCursor(doc);
  if (!time) return null;
  const data = doc.data();
  return { ...time, upvotes: data.upvotes ?? 0, commentCount: data.commentCount ?? 0 };
}

function encodeRelevanceCursor(cursor: RelevanceFeedCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function isTimestampCursor(value: unknown): value is TimestampCursor {
  if (typeof value !== 'object' || value === null) return false;
  const cursor = value as Record<string, unknown>;
  return Number.isSafeInteger(cursor.seconds) && Number(cursor.seconds) >= -62_135_596_800 && Number(cursor.seconds) <= 253_402_300_799 && Number.isInteger(cursor.nanoseconds) && Number(cursor.nanoseconds) >= 0 && Number(cursor.nanoseconds) < 1_000_000_000 && typeof cursor.id === 'string' && Boolean(cursor.id) && !cursor.id.includes('/');
}

function isPopularCursor(value: unknown): value is PopularCursor {
  if (!isTimestampCursor(value)) return false;
  const cursor = value as Record<string, unknown>;
  return Number.isSafeInteger(cursor.upvotes) && Number(cursor.upvotes) >= 0 && Number.isSafeInteger(cursor.commentCount) && Number(cursor.commentCount) >= 0;
}

function decodeRelevanceCursor(value: string | null): RelevanceFeedCursor | null {
  if (!value) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null) return null;
    const cursor = decoded as Record<string, unknown>;
    if (cursor.version !== 1 || !Number.isSafeInteger(cursor.asOf) || Number(cursor.asOf) <= 0 || Number(cursor.asOf) > 253_402_300_799_999 || (cursor.popular !== null && !isPopularCursor(cursor.popular)) || (cursor.fresh !== null && !isTimestampCursor(cursor.fresh)) || typeof cursor.freshDone !== 'boolean') return null;
    return cursor as unknown as RelevanceFeedCursor;
  } catch {
    return null;
  }
}

function relevanceScore(data: { upvotes?: number; commentCount?: number; createdAt?: { toMillis?: () => number } }, asOf: number) {
  const age = Math.max(0, asOf - (data.createdAt?.toMillis?.() ?? asOf));
  const freshness = Math.max(0, Math.min(1, 1 - age / RELEVANCE_BOOST_WINDOW_MS));
  return (data.upvotes ?? 0) + (data.commentCount ?? 0) * 0.5 + freshness * RELEVANCE_BOOST_POINTS;
}

export async function GET(request: Request) {
  if (!adminDb) return NextResponse.json({ error: 'Video service is not configured.' }, { status: 503, headers });
  const url = new URL(request.url);
  const limit = Math.min(18, Math.max(1, Number(url.searchParams.get('limit')) || 8));
  const sort = url.searchParams.get('sort') ?? 'upvotes';
  if (sort === 'relevance') {
    const rawCursor = url.searchParams.get('cursor');
    const decodedCursor = decodeRelevanceCursor(rawCursor);
    if (rawCursor && !decodedCursor) return NextResponse.json({ error: 'Invalid video cursor.' }, { status: 400, headers });
    const cursor = decodedCursor ?? { version: 1 as const, asOf: Date.now(), popular: null, fresh: null, freshDone: false };
    let popularQuery = adminDb.collection('videos')
      .where('status', '==', 'Published')
      .orderBy('upvotes', 'desc')
      .orderBy('commentCount', 'desc')
      .orderBy('createdAt', 'desc')
      .orderBy(FieldPath.documentId(), 'asc')
      .limit(limit + 1);
    if (cursor.popular) popularQuery = popularQuery.startAfter(cursor.popular.upvotes, cursor.popular.commentCount, new Timestamp(cursor.popular.seconds, cursor.popular.nanoseconds), cursor.popular.id);
    let freshQuery = adminDb.collection('videos')
      .where('status', '==', 'Published')
      .where('createdAt', '>=', Timestamp.fromMillis(cursor.asOf - RELEVANCE_BOOST_WINDOW_MS))
      .where('createdAt', '<=', Timestamp.fromMillis(cursor.asOf))
      .orderBy('createdAt', 'desc')
      .orderBy(FieldPath.documentId(), 'asc')
      .limit(2);
    if (cursor.fresh) freshQuery = freshQuery.startAfter(new Timestamp(cursor.fresh.seconds, cursor.fresh.nanoseconds), cursor.fresh.id);
    const [popularSnapshot, freshSnapshot] = await Promise.all([popularQuery.get(), cursor.freshDone ? Promise.resolve(null) : freshQuery.get()]);
    const popularPage = popularSnapshot.docs.slice(0, limit);
    const freshVideo = freshSnapshot?.docs[0];
    const orderedDocs = [...popularPage];
    if (freshVideo) {
      const duplicateIndex = orderedDocs.findIndex(doc => doc.id === freshVideo.id);
      if (duplicateIndex >= 0) orderedDocs.splice(duplicateIndex, 1);
      const mostRelevant = orderedDocs[0];
      const insertAt = mostRelevant && relevanceScore(mostRelevant.data(), cursor.asOf) >= relevanceScore(freshVideo.data(), cursor.asOf) ? 1 : 0;
      orderedDocs.splice(Math.min(insertAt, orderedDocs.length), 0, freshVideo);
    }
    const page = orderedDocs.slice(0, limit);
    let consumedPopular = 0;
    while (consumedPopular < popularPage.length && page.some(doc => doc.id === popularPage[consumedPopular].id)) consumedPopular++;
    const lastConsumedPopular = consumedPopular ? popularCursor(popularPage[consumedPopular - 1]) : cursor.popular;
    const morePopular = consumedPopular < popularSnapshot.docs.length;
    const nextFresh = freshVideo ? timestampCursor(freshVideo) ?? cursor.fresh : cursor.fresh;
    const moreFresh = Boolean(freshVideo && freshSnapshot && freshSnapshot.docs.length > 1 && nextFresh);
    const freshDone = cursor.freshDone || !moreFresh;
    const nextCursor = morePopular || moreFresh
      ? encodeRelevanceCursor({ version: 1, asOf: cursor.asOf, popular: lastConsumedPopular, fresh: nextFresh, freshDone })
      : null;
    const profiles = await playerDisplayProfiles(page.map(doc => doc.data().uploaderId).filter((id): id is string => typeof id === 'string'), new Map(page.map(doc => [doc.data().uploaderId, doc.data().uploaderEmail ?? ''])));
    const videos = await Promise.all(page.map(async doc => { const data = doc.data(), profile = typeof data.uploaderId === 'string' ? profiles.get(data.uploaderId) : undefined; return { id: doc.id, title: data.title, description: data.description ?? '', uploader: profile?.username ?? (typeof data.uploaderId === 'string' ? data.uploaderName ?? fallbackPlayerName(data.uploaderEmail ?? '') : data.uploaderName ?? data.uploaderEmail), uploaderAvatarUrl: profile?.avatarUrl ?? null, uploaderId: data.uploaderId ?? null, thumbnailUrl: await signedVideoUrl(data.thumbnailKey), upvotes: data.upvotes ?? 0, downvotes: data.downvotes ?? 0, commentCount: data.commentCount ?? 0, createdAt: data.createdAt?.toDate?.().toISOString() ?? null }; }));
    return NextResponse.json({ videos, nextCursor }, { headers });
  }
  if (sort !== 'newest') {
    const snapshot = await adminDb.collection('videos').where('status', '==', 'Published').get();
    const ordered = snapshot.docs.sort((a, b) =>
      (b.data().upvotes ?? 0) - (a.data().upvotes ?? 0)
      || (b.data().createdAt?.toMillis?.() ?? 0) - (a.data().createdAt?.toMillis?.() ?? 0)
      || a.id.localeCompare(b.id),
    );
    const requestedOffset = Number(url.searchParams.get('cursor'));
    const offset = Number.isSafeInteger(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;
    const page = ordered.slice(offset, offset + limit);
    const profiles = await playerDisplayProfiles(page.map(doc => doc.data().uploaderId).filter((id): id is string => typeof id === 'string'), new Map(page.map(doc => [doc.data().uploaderId, doc.data().uploaderEmail ?? ''])));
    const videos = await Promise.all(page.map(async doc => { const data = doc.data(), profile = typeof data.uploaderId === 'string' ? profiles.get(data.uploaderId) : undefined; return { id: doc.id, title: data.title, description: data.description ?? '', uploader: profile?.username ?? (typeof data.uploaderId === 'string' ? data.uploaderName ?? fallbackPlayerName(data.uploaderEmail ?? '') : data.uploaderName ?? data.uploaderEmail), uploaderAvatarUrl: profile?.avatarUrl ?? null, uploaderId: data.uploaderId ?? null, thumbnailUrl: await signedVideoUrl(data.thumbnailKey), upvotes: data.upvotes ?? 0, downvotes: data.downvotes ?? 0, commentCount: data.commentCount ?? 0, createdAt: data.createdAt?.toDate?.().toISOString() ?? null }; }));
    const nextCursor = offset + page.length < ordered.length ? offset + page.length : null;
    return NextResponse.json({ videos, nextCursor }, { headers });
  }
  const cursor = Number(url.searchParams.get('cursor'));
  let query = adminDb.collection('videos').orderBy('createdAt', 'desc').limit(limit + 1);
  if (Number.isFinite(cursor) && cursor > 0) query = query.startAfter(new Date(cursor));
  const snapshot = await query.get();
  const page = snapshot.docs.slice(0, limit);
  const profiles = await playerDisplayProfiles(page.map((doc) => doc.data().uploaderId).filter((id): id is string => typeof id === 'string'), new Map(page.map((doc) => [doc.data().uploaderId, doc.data().uploaderEmail ?? ''])));
  const videos = await Promise.all(page.filter(doc => doc.data().status === 'Published').map(async doc => {
    const data = doc.data();
    const profile = typeof data.uploaderId === 'string' ? profiles.get(data.uploaderId) : undefined;
    return { id: doc.id, title: data.title, description: data.description ?? '', uploader: profile?.username ?? (typeof data.uploaderId === 'string' ? data.uploaderName ?? fallbackPlayerName(data.uploaderEmail ?? '') : data.uploaderName ?? data.uploaderEmail), uploaderAvatarUrl: profile?.avatarUrl ?? null, uploaderId: data.uploaderId ?? null, thumbnailUrl: await signedVideoUrl(data.thumbnailKey), upvotes: data.upvotes ?? 0, downvotes: data.downvotes ?? 0, commentCount: data.commentCount ?? 0, createdAt: data.createdAt?.toDate?.().toISOString() ?? null };
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
    if (typeof videoKey !== 'string' || !videoKey.startsWith(`videos/${player.id}/`) || !videoKey.endsWith('.mp4')) throw new Error('Invalid video upload.');
    if (typeof thumbnailKey !== 'string' || !thumbnailKey.startsWith(`video-thumbnails/${player.id}/`)) throw new Error('Invalid video thumbnail.');
    const uploadedVideo = await headVideoObject(videoKey);
    if (uploadedVideo.Metadata?.['ambatu-compression'] !== VIDEO_COMPRESSION_VERSION || uploadedVideo.ContentType !== 'video/mp4') throw new Error('Wait for video compression to finish.');
    const profile = (await playerDisplayProfiles([player.id], new Map([[player.id, player.email]]))).get(player.id);
    const data = { title: title.trim(), description: description.trim(), videoKey, thumbnailKey, uploaderEmail: player.email, uploaderName: profile?.username ?? fallbackPlayerName(player.email), uploaderId: player.id, status: 'Published', upvotes: 0, downvotes: 0, commentCount: 0, createdAt: FieldValue.serverTimestamp() };
    const ref = await adminDb.collection('videos').add(data);
    return NextResponse.json({ id: ref.id, ...data, uploaderAvatarUrl: profile?.avatarUrl ?? null, createdAt: new Date().toISOString(), thumbnailUrl: await signedVideoUrl(thumbnailKey) }, { status: 201, headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not publish video.' }, { status: 400, headers });
  }
}
