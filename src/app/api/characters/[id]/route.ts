import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '../../../../lib/firebase-admin';
import { requireAdmin } from '../../../../lib/api-auth';
import { adminErrorStatus } from '../../../../lib/studio-api';
import { characterImageKey, deleteCharacterImage, signedCharacterImageUrl } from '../../../../lib/s3-images';
import { canManageStudioContent } from '../../../../lib/studio-content';

export const runtime = 'nodejs';
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireAdmin(request);
    if (!adminDb) return NextResponse.json({ error: 'Firestore is not configured.' }, { status: 503 });
    const body = await request.json(), { id } = await params;
    const ref = adminDb.collection('characters').doc(id), snapshot = await ref.get(), stored = snapshot.data();
    if (!stored) return NextResponse.json({ error: 'Character not found.' }, { status: 404 });
    if (!canManageStudioContent(actor, stored)) return NextResponse.json({ error: 'Character not found.' }, { status: 404 });
    const { imageUrl: _imageUrl, image: _image, createdBy: _createdBy, createdAt: _createdAt, updatedAt: _updatedAt, ...update } = body;
    if (actor && actor.roleId !== 'root' && typeof update.imageKey === 'string' && update.imageKey !== stored.imageKey && update.imageKey !== stored.image && !update.imageKey.startsWith(`characters/${actor.sub}/`)) throw new Error('studio.errors.forbidden');
    await ref.set({ ...update, updatedAt: FieldValue.serverTimestamp(), updated: 'Just now' }, { merge: true });
    const result = (await ref.get()).data();
    const { createdBy: _storedCreatedBy, ...visible } = result ?? {};
    return NextResponse.json({ id, ...visible, imageUrl: await signedCharacterImageUrl(characterImageKey(result?.imageKey, result?.image)), updated: 'Just now' });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status: adminErrorStatus(error, 400) }); }
}
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireAdmin(request);
    if (!adminDb) return NextResponse.json({ error: 'Firestore is not configured.' }, { status: 503 });
    const { id } = await params, ref = adminDb.collection('characters').doc(id), stored = (await ref.get()).data();
    if (!stored || !canManageStudioContent(actor, stored)) return NextResponse.json({ error: 'Character not found.' }, { status: 404 });
    await deleteCharacterImage(characterImageKey(stored.imageKey, stored.image));
    await ref.delete();
    return NextResponse.json({ id });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status: adminErrorStatus(error, 400) }); }
}
