import { NextResponse } from 'next/server';
import { adminDb } from '../../../lib/firebase-admin';
import { requireAdmin } from '../../../lib/api-auth';
import { profileAvatarUrl } from '../../../lib/profile-avatars';

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    if (!adminDb) return NextResponse.json({ active: [] }, { status: 200 });
    const snapshot = await adminDb.collection('playerProfiles').where('avatarType', '==', 'custom').get();
    const active = await Promise.all(snapshot.docs.filter(doc => typeof doc.data().avatarKey === 'string').map(async doc => ({
      userId: doc.id,
      username: doc.data().username ?? doc.id,
      imageUrl: await profileAvatarUrl(doc.data().avatarKey),
    })));
    return NextResponse.json({ active });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load custom profile images.' }, { status: 401 }); }
}
