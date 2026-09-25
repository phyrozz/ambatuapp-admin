import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../../../lib/player-auth';
import { bestEffortDeleteProfileAvatar, newProfileAvatarKey, PROFILE_AVATAR_LIMIT, profileAvatarUrl, readJpegDimensions, uploadProfileAvatar } from '../../../../../../lib/profile-avatars';

export const runtime = 'nodejs';
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function POST(request: Request) {
  let uploadedKey: string | undefined;
  try {
    if (!adminDb) return NextResponse.json({ error: 'Profile service is not configured.' }, { status: 503, headers });
    const player = await requirePlayer(request);
    const form = await request.formData();
    const file = form.get('image');
    if (!(file instanceof File)) return NextResponse.json({ error: 'Choose a profile image.' }, { status: 400, headers });
    if (file.size >= PROFILE_AVATAR_LIMIT) return NextResponse.json({ error: 'Profile images must be smaller than 3 MB.' }, { status: 413, headers });
    if (file.type !== 'image/jpeg') return NextResponse.json({ error: 'Upload a cropped JPG image.' }, { status: 400, headers });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const dimensions = readJpegDimensions(bytes);
    if (!dimensions || dimensions.width !== dimensions.height || dimensions.width > 512) return NextResponse.json({ error: 'The cropped image must be square and no larger than 512 pixels.' }, { status: 400, headers });

    const profileRef = adminDb.collection('playerProfiles').doc(player.id);
    const moderationRef = adminDb.collection('profileAvatarModeration').doc(player.id);
    const imageKey = newProfileAvatarKey('custom', 'jpg');
    uploadedKey = imageKey;
    await uploadProfileAvatar(imageKey, bytes, 'image/jpeg', 'private, no-store, max-age=0, must-revalidate');
    const previousKey = await adminDb.runTransaction(async transaction => {
      const profileSnapshot = await transaction.get(profileRef);
      const profile = profileSnapshot.data() ?? {};
      const oldKey = profile.avatarType === 'custom' && typeof profile.avatarKey === 'string' ? profile.avatarKey : undefined;
      const username = typeof profile.username === 'string' ? profile.username : player.email.split('@')[0];
      transaction.set(profileRef, { avatarType: 'custom', avatarId: null, avatarKey: imageKey, updatedAt: new Date() }, { merge: true });
      transaction.set(moderationRef, { userId: player.id, username, imageKey, status: 'active', updatedAt: new Date() }, { merge: true });
      return oldKey;
    });
    if (previousKey && previousKey !== imageKey) await bestEffortDeleteProfileAvatar(previousKey);
    return NextResponse.json({ avatarType: 'custom', avatarUrl: await profileAvatarUrl(imageKey) }, { status: 200, headers });
  } catch (error) {
    if (uploadedKey) await bestEffortDeleteProfileAvatar(uploadedKey);
    const message = error instanceof Error ? error.message : 'Could not submit profile image.';
    return NextResponse.json({ error: message }, { status: message.includes('already waiting') ? 409 : 400, headers });
  }
}
