import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/api-auth';
import { adminDb } from '../../../../lib/firebase-admin';
import { adminUploadKeys, deleteVideoAssets, hydrateVideo, videoFields } from '../../../../lib/admin-video';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    await requireAdmin(request);
    if (!adminDb) return NextResponse.json({ error: 'Video service is not configured.' }, { status: 503 });
    const { id } = await params;
    const ref = adminDb.collection('videos').doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) return NextResponse.json({ error: 'Video not found.' }, { status: 404 });
    const body = await request.json();
    const fields = videoFields(body);
    const keys = body.videoKey || body.thumbnailKey ? adminUploadKeys(body) : {};
    await ref.update({ ...fields, ...keys, updatedAt: FieldValue.serverTimestamp() });
    if ('videoKey' in keys) await deleteVideoAssets(snapshot.data() ?? {});
    return NextResponse.json(await hydrateVideo(id, (await ref.get()).data() ?? {}));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not update video.' }, { status: 400 });
  }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    await requireAdmin(request);
    if (!adminDb) return NextResponse.json({ error: 'Video service is not configured.' }, { status: 503 });
    const { id } = await params;
    const ref = adminDb.collection('videos').doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) return NextResponse.json({ error: 'Video not found.' }, { status: 404 });
    await deleteVideoAssets(snapshot.data() ?? {});
    await adminDb.recursiveDelete(ref);
    return NextResponse.json({ id });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not delete video.' }, { status: 400 });
  }
}
