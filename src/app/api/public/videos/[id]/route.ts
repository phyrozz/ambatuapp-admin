import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../lib/firebase-admin';
import { deleteVideoAssets } from '../../../../../lib/admin-video';
import { requirePlayer, playerFromRequest } from '../../../../../lib/player-auth';
import { signedVideoUrl } from '../../../../../lib/s3-videos';
import { fallbackPlayerName, playerDisplayProfiles } from '../../../../../lib/player-profiles';
import { allowPlayerWrite } from '../../../../../lib/public-write-limits';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'GET, PATCH, DELETE, OPTIONS', 'Cache-Control': 'no-store' };
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

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let player: Awaited<ReturnType<typeof requirePlayer>>;
  try { player = await requirePlayer(request); }
  catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  if (!adminDb) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers });

  const { id } = await params;
  if (!/^[\w-]{1,128}$/.test(id)) return NextResponse.json({ error: 'VIDEO_NOT_FOUND' }, { status: 404, headers });
  const ref = adminDb.collection('videos').doc(id);

  try {
    const snapshot = await ref.get();
    const prior = snapshot.data();
    if (!prior || prior.status !== 'Published' || prior.uploaderId !== player.id) {
      return NextResponse.json({ error: 'VIDEO_NOT_FOUND' }, { status: 404, headers });
    }
    if (!await allowPlayerWrite(adminDb, player.id, 'videoManage', [
      { key: 'minute', max: 15, windowMs: 60_000 },
      { key: 'day', max: 100, windowMs: 24 * 60 * 60_000 },
    ])) return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429, headers });

    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400, headers });
    }
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (!title || title.length > 120) return NextResponse.json({ error: 'INVALID_TITLE' }, { status: 400, headers });
    if (description.length > 1000) return NextResponse.json({ error: 'INVALID_DESCRIPTION' }, { status: 400, headers });

    await ref.update({ title, description, updatedAt: FieldValue.serverTimestamp() });
    return NextResponse.json({ id, title, description }, { headers });
  } catch {
    return NextResponse.json({ error: 'VIDEO_UPDATE_FAILED' }, { status: 500, headers });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let player: Awaited<ReturnType<typeof requirePlayer>>;
  try { player = await requirePlayer(request); }
  catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  if (!adminDb) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers });

  const { id } = await params;
  if (!/^[\w-]{1,128}$/.test(id)) return NextResponse.json({ error: 'VIDEO_NOT_FOUND' }, { status: 404, headers });
  const ref = adminDb.collection('videos').doc(id);

  try {
    const snapshot = await ref.get();
    const prior = snapshot.data();
    if (!prior || prior.status !== 'Published' || prior.uploaderId !== player.id) {
      return NextResponse.json({ error: 'VIDEO_NOT_FOUND' }, { status: 404, headers });
    }
    if (!await allowPlayerWrite(adminDb, player.id, 'videoManage', [
      { key: 'minute', max: 15, windowMs: 60_000 },
      { key: 'day', max: 100, windowMs: 24 * 60 * 60_000 },
    ])) return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429, headers });

    const videoPrefix = `videos/${player.id}/`;
    const thumbnailPrefix = `video-thumbnails/${player.id}/`;
    const videoKey = typeof prior.videoKey === 'string' && prior.videoKey.startsWith(videoPrefix) ? prior.videoKey : '';
    const thumbnailKey = typeof prior.thumbnailKey === 'string' && prior.thumbnailKey.startsWith(thumbnailPrefix) ? prior.thumbnailKey : '';
    const videoName = videoKey.slice(videoPrefix.length);
    const thumbnailName = thumbnailKey.slice(thumbnailPrefix.length);
    if (!/^[a-f0-9-]{36}\.mp4$/i.test(videoName)
      || (thumbnailKey && (!/^[a-f0-9-]{36}\.jpg$/i.test(thumbnailName) || thumbnailName.slice(0, -4) !== videoName.slice(0, -4)))) {
      return NextResponse.json({ error: 'VIDEO_DELETE_FAILED' }, { status: 500, headers });
    }

    await deleteVideoAssets({ videoKey, ...(thumbnailKey ? { thumbnailKey } : {}) });
    await adminDb.recursiveDelete(ref);
    return NextResponse.json({ ok: true }, { headers });
  } catch {
    return NextResponse.json({ error: 'VIDEO_DELETE_FAILED' }, { status: 500, headers });
  }
}
