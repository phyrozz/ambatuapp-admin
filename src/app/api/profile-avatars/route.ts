import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '../../../lib/firebase-admin';
import { requireAdmin } from '../../../lib/api-auth';
import { avatarImageType, bestEffortDeleteProfileAvatar, newProfileAvatarKey, PROFILE_AVATAR_LIMIT, profileAvatarUrl, uploadProfileAvatar } from '../../../lib/profile-avatars';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    if (!adminDb) return NextResponse.json({ avatars: [] }, { status: 200 });
    const snapshot = await adminDb.collection('profileAvatars').orderBy('createdAt', 'desc').get();
    const avatars = await Promise.all(snapshot.docs.map(async doc => {
      const users = await adminDb!.collection('playerProfiles').where('avatarId', '==', doc.id).count().get();
      return { id: doc.id, name: doc.data().name ?? '', imageUrl: await profileAvatarUrl(doc.data().imageKey), userCount: users.data().count };
    }));
    return NextResponse.json({ avatars });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load avatar presets.' }, { status: 401 }); }
}

export async function POST(request: Request) {
  let imageKey: string | undefined;
  try {
    await requireAdmin(request);
    if (!adminDb) return NextResponse.json({ error: 'Firestore is not configured.' }, { status: 503 });
    const form = await request.formData();
    const name = String(form.get('name') ?? '').normalize('NFKC').trim().slice(0, 48);
    const file = form.get('image');
    if (!name) return NextResponse.json({ error: 'Enter a name for this avatar.' }, { status: 400 });
    if (!(file instanceof File)) return NextResponse.json({ error: 'Choose an image.' }, { status: 400 });
    if (file.size >= PROFILE_AVATAR_LIMIT) return NextResponse.json({ error: 'Preset images must be smaller than 3 MB.' }, { status: 413 });
    const extension = avatarImageType(file.type);
    if (!extension) return NextResponse.json({ error: 'Use a PNG or JPG image.' }, { status: 400 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const id = crypto.randomUUID();
    imageKey = newProfileAvatarKey('presets', extension);
    await uploadProfileAvatar(imageKey, bytes, extension === 'png' ? 'image/png' : 'image/jpeg');
    await adminDb.collection('profileAvatars').doc(id).set({ name, imageKey, contentType: extension === 'png' ? 'image/png' : 'image/jpeg', createdAt: FieldValue.serverTimestamp() });
    return NextResponse.json({ id, name, imageUrl: await profileAvatarUrl(imageKey), userCount: 0 }, { status: 201 });
  } catch (error) {
    if (imageKey) await bestEffortDeleteProfileAvatar(imageKey);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not add avatar preset.' }, { status: 400 });
  }
}
