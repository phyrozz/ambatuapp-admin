import { NextResponse } from 'next/server';
import { isDevLoreWriter } from '../../../../lib/dev-content-db';
import { deleteStudioLore, editStudioLore } from '../../../../lib/dev-lores';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '../../../../lib/firebase-admin';
import { requireAdmin } from '../../../../lib/api-auth';
import { adminErrorStatus } from '../../../../lib/studio-api';
import { deleteCharacterImage, signedCharacterImageUrl } from '../../../../lib/s3-images';
import { LORE_TEXT_LIMIT } from '../../../../lib/lore';
import { canManageStudioContent } from '../../../../lib/studio-content';

export const runtime = 'nodejs';
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireAdmin(request);
    if (!adminDb) return NextResponse.json({ error: 'Firestore is not configured.' }, { status: 503 });
    const body = await request.json();
    if (typeof body.text !== 'string' || !body.text.trim()) throw new Error('Lore text is required.');
    if (body.text.length > LORE_TEXT_LIMIT) throw new Error(`Lore text cannot exceed ${LORE_TEXT_LIMIT.toLocaleString()} characters.`);
    if (isDevLoreWriter()) return NextResponse.json(await editStudioLore(actor, (await params).id, body));
    const { imageUrls: _imageUrls, createdBy: _createdBy, createdAt: _createdAt, updatedAt: _updatedAt, ...update } = body;
    const { id } = await params, ref = adminDb.collection('lores').doc(id), snapshot = await ref.get(), prior = snapshot.data();
    if (!prior || !canManageStudioContent(actor, prior)) return NextResponse.json({ error: 'Lore not found.' }, { status: 404 });
    if (actor && actor.roleId !== 'root' && Array.isArray(update.imageKeys)) {
      const existingKeys = new Set(Array.isArray(prior.imageKeys) ? prior.imageKeys : []);
      if (update.imageKeys.some((key: unknown) => typeof key !== 'string' || (!existingKeys.has(key) && !key.startsWith(`lores/${actor.sub}/`)))) throw new Error('studio.errors.forbidden');
    }
    await ref.set({ ...update, updatedAt: FieldValue.serverTimestamp(), updated: 'Just now' }, { merge: true });
    const data = (await ref.get()).data()!;
    const { createdBy: _storedCreatedBy, ...visible } = data;
    const keys = Array.isArray(visible.imageKeys) ? visible.imageKeys : [];
    return NextResponse.json({ id, ...visible, imageUrls: await Promise.all(keys.map(signedCharacterImageUrl)) });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status: adminErrorStatus(error, 400) }); }
}
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireAdmin(request);
    if (!adminDb) return NextResponse.json({ error: 'Firestore is not configured.' }, { status: 503 });
    const { id } = await params;
    if (isDevLoreWriter()) { await deleteStudioLore(actor, id); return NextResponse.json({ id }); }
    const ref = adminDb.collection('lores').doc(id), data = (await ref.get()).data();
    if (!data || !canManageStudioContent(actor, data)) return NextResponse.json({ error: 'Lore not found.' }, { status: 404 });
    const keys = Array.isArray(data.imageKeys) ? data.imageKeys.filter((key): key is string => typeof key === 'string') : [];
    await Promise.all(keys.map(deleteCharacterImage));
    await ref.delete();
    return NextResponse.json({ id });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status: adminErrorStatus(error, 400) }); }
}
