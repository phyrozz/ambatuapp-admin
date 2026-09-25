import { NextResponse } from 'next/server';
import { adminDb } from '../../../../lib/firebase-admin';
import { requireAdmin } from '../../../../lib/api-auth';
import { bestEffortDeleteProfileAvatar } from '../../../../lib/profile-avatars';

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(request);
    if (!adminDb) return NextResponse.json({ error: 'Firestore is not configured.' }, { status: 503 });
    const { id } = await params;
    const ref = adminDb.collection('profileAvatars').doc(id);
    const key = await adminDb.runTransaction(async transaction => {
      const [snapshot, usage] = await Promise.all([
        transaction.get(ref),
        transaction.get(adminDb!.collection('playerProfiles').where('avatarId', '==', id).limit(1)),
      ]);
      if (!snapshot.exists) throw Object.assign(new Error('Avatar preset not found.'), { status: 404 });
      if (!usage.empty) throw Object.assign(new Error('This avatar is in use and cannot be deleted.'), { status: 409 });
      transaction.delete(ref);
      return snapshot.data()?.imageKey;
    });
    await bestEffortDeleteProfileAvatar(typeof key === 'string' ? key : undefined);
    return NextResponse.json({ id });
  } catch (error) { const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 400; return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not delete avatar preset.' }, { status }); }
}
