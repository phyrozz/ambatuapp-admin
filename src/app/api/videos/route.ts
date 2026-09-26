import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../lib/api-auth';
import { adminDb } from '../../../lib/firebase-admin';
import { adminUploadKeys, hydrateVideo, videoFields } from '../../../lib/admin-video';
import { headVideoObject, VIDEO_COMPRESSION_VERSION } from '../../../lib/video-transcoding.mjs';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    if (!adminDb) return NextResponse.json({ error: 'Video service is not configured.' }, { status: 503 });
    const snapshot = await adminDb.collection('videos').orderBy('createdAt', 'desc').get();
    const videos = await Promise.all(snapshot.docs.map(doc => hydrateVideo(doc.id, doc.data())));
    return NextResponse.json({ videos });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load videos.' }, { status: 401 });
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    if (!adminDb) return NextResponse.json({ error: 'Video service is not configured.' }, { status: 503 });
    const body = await request.json();
    const fields = videoFields(body);
    const keys = adminUploadKeys(body);
    const uploadedVideo = await headVideoObject(keys.videoKey);
    if (uploadedVideo.Metadata?.['ambatu-compression'] !== VIDEO_COMPRESSION_VERSION || uploadedVideo.ContentType !== 'video/mp4') throw new Error('Wait for video compression to finish.');
    const stored = { ...fields, ...keys, uploaderEmail: 'Ambatu Admin', uploaderId: 'admin', upvotes: 0, downvotes: 0, commentCount: 0, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
    const ref = await adminDb.collection('videos').add(stored);
    return NextResponse.json(await hydrateVideo(ref.id, (await ref.get()).data() ?? {}), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not create video.' }, { status: 400 });
  }
}
