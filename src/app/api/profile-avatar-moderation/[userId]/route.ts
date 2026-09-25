import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '../../../../lib/firebase-admin';
import { requireAdmin } from '../../../../lib/api-auth';
import { bestEffortDeleteProfileAvatar } from '../../../../lib/profile-avatars';

export async function PATCH(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    await requireAdmin(request);
    if (!adminDb) return NextResponse.json({ error: 'Firestore is not configured.' }, { status: 503 });
    const { userId } = await params;
    const { decision } = await request.json() as { decision?: unknown };
    if (decision !== 'remove') return NextResponse.json({ error: 'Choose a valid moderation action.' }, { status: 400 });
    const profileRef = adminDb.collection('playerProfiles').doc(userId);
    const moderationRef = adminDb.collection('profileAvatarModeration').doc(userId);
    const deleteKey = await adminDb.runTransaction(async transaction => {
      const profileSnapshot = await transaction.get(profileRef);
      const profile = profileSnapshot.data() ?? {};
      if (profile.avatarType !== 'custom' || typeof profile.avatarKey !== 'string') throw new Error('This player does not have a custom avatar in use.');
      const previousKey = profile.avatarKey;
      transaction.set(profileRef, { avatarType: null, avatarId: null, avatarKey: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      transaction.set(moderationRef, { userId, status: 'removed', imageKey: null, reviewedAt: FieldValue.serverTimestamp() }, { merge: true });
      return previousKey;
    });
    await bestEffortDeleteProfileAvatar(deleteKey);
    return NextResponse.json({ ok: true });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not remove profile image.' }, { status: 400 }); }
}
