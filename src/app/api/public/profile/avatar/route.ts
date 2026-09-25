import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../../lib/player-auth';
import { bestEffortDeleteProfileAvatar } from '../../../../../lib/profile-avatars';
import { FieldValue } from 'firebase-admin/firestore';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function POST(request: Request) {
  try {
    if (!adminDb) return NextResponse.json({ error: 'Profile service is not configured.' }, { status: 503, headers });
    const player = await requirePlayer(request);
    const { avatarId } = await request.json() as { avatarId?: unknown };
    const profileRef = adminDb.collection('playerProfiles').doc(player.id);
    const moderationRef = adminDb.collection('profileAvatarModeration').doc(player.id);
    let presetRef: FirebaseFirestore.DocumentReference | null = null;
    if (avatarId !== null) {
      if (typeof avatarId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(avatarId)) return NextResponse.json({ error: 'Choose a valid avatar.' }, { status: 400, headers });
      presetRef = adminDb.collection('profileAvatars').doc(avatarId);
    }
    const removedKeys = await adminDb.runTransaction(async transaction => {
      const [profileSnapshot, moderationSnapshot, presetSnapshot] = await Promise.all([
        transaction.get(profileRef), transaction.get(moderationRef), presetRef ? transaction.get(presetRef) : Promise.resolve(null),
      ]);
      const preset = presetSnapshot?.data();
      if (presetRef && (!presetSnapshot?.exists || typeof preset?.imageKey !== 'string')) throw new Error('That avatar is no longer available.');
      const previous = profileSnapshot.data() ?? {};
      const avatarKey = presetRef ? preset!.imageKey as string : null;
      transaction.set(profileRef, { avatarType: presetRef ? 'preset' : null, avatarId: presetRef ? avatarId : null, avatarKey, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      const moderation = moderationSnapshot.data() ?? {};
      const removedKeys = new Set<string>();
      if ((moderation.status === 'active' || moderation.status === 'pending') && typeof moderation.imageKey === 'string' && moderation.imageKey !== avatarKey) removedKeys.add(moderation.imageKey);
      const previousKey = previous.avatarType === 'custom' && typeof previous.avatarKey === 'string' && previous.avatarKey !== avatarKey ? previous.avatarKey : undefined;
      if (previousKey) removedKeys.add(previousKey);
      if (moderationSnapshot.exists) transaction.set(moderationRef, { status: 'inactive', imageKey: null, reviewedAt: FieldValue.serverTimestamp() }, { merge: true });
      return [...removedKeys];
    });
    await Promise.all(removedKeys.map(key => bestEffortDeleteProfileAvatar(key)));
    return NextResponse.json({ avatarType: avatarId ? 'preset' : null, avatarId: avatarId ?? null }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not save profile avatar.' }, { status: 400, headers });
  }
}
