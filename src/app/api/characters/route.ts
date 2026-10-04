import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '../../../lib/firebase-admin';
import { requireAdmin } from '../../../lib/api-auth';
import { adminErrorStatus } from '../../../lib/studio-api';
import { characterImageKey, signedCharacterImageUrl } from '../../../lib/s3-images';
import { isStudioRoot } from '../../../lib/studio-content';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const actor = await requireAdmin(request);
    if (!adminDb) return NextResponse.json({ configured: false, characters: [] });
    const snapshot = isStudioRoot(actor)
      ? await adminDb.collection('characters').orderBy('updatedAt', 'desc').get()
      : await adminDb.collection('characters').where('createdBy', '==', actor!.sub).get();
    const docs = [...snapshot.docs].sort((a, b) => (b.data().updatedAt?.toMillis?.() ?? 0) - (a.data().updatedAt?.toMillis?.() ?? 0));
    const characters = await Promise.all(docs.map(async doc => { const { createdBy: _createdBy, ...data } = doc.data(); const imageKey = characterImageKey(data.imageKey, data.image); return { id: doc.id, ...data, imageKey, imageUrl: await signedCharacterImageUrl(imageKey), updated: data.updated ?? 'Recently' }; }));
    return NextResponse.json({ configured: true, characters });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Unauthorized' }, { status: adminErrorStatus(error, 401) }); }
}
export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);
    if (!adminDb) return NextResponse.json({ error: 'Firestore is not configured.' }, { status: 503 });
    const body = await request.json();
    const imageKey = typeof body.imageKey === 'string' ? body.imageKey : null;
    if (actor && actor.roleId !== 'root' && imageKey && !imageKey.startsWith(`characters/${actor.sub}/`)) throw new Error('studio.errors.forbidden');
    const stored = { name: body.name, title: body.title, bio: body.bio ?? '', status: body.status ?? 'Draft', tags: body.tags ?? [], imageKey, ...(actor ? { createdBy: actor.sub } : {}), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), updated: 'Just now' };
    const ref = await adminDb.collection('characters').add(stored);
    const { createdBy: _createdBy, ...visible } = stored;
    return NextResponse.json({ id: ref.id, ...visible, createdAt: null, updatedAt: null, imageUrl: await signedCharacterImageUrl(imageKey ?? undefined), updated: 'Just now' }, { status: 201 });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status: adminErrorStatus(error, 400) }); }
}
