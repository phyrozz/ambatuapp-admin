import { NextResponse } from 'next/server';
import { isDevProfileWriter } from '../../../../lib/dev-content-db';
import { getProfile, updateProfile } from '../../../../lib/dev-profiles';
import { adminDb } from '../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../lib/player-auth';
import { fallbackPlayerName } from '../../../../lib/player-profiles';
import { profileAvatarUrl } from '../../../../lib/profile-avatars';
import { FieldValue } from 'firebase-admin/firestore';
import { emailSearchKey } from '../../../../lib/creator-search';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Cache-Control': 'no-store' };
const usernamePattern = /^[\p{L}\p{N}][\p{L}\p{N} _-]{1,23}$/u;

class UsernameTakenError extends Error {}

export function OPTIONS() { return new NextResponse(null, { headers }); }
function json(body: unknown, status = 200) { return NextResponse.json(body, { status, headers }); }

function validBirthDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return false;
  return value <= new Date().toISOString().slice(0, 10) && year >= 1900;
}

export async function GET(request: Request) {
  try {
    if (!adminDb && !isDevProfileWriter()) throw new Error('Player profile service is not configured.');
    const player = await requirePlayer(request);
    if (isDevProfileWriter()) return json(await getProfile(player.id, player.email));
    const data = (await adminDb!.collection('playerProfiles').doc(player.id).get()).data();
    const moderation = await adminDb!.collection('profileAvatarModeration').doc(player.id).get();
    return json({ username: typeof data?.username === 'string' ? data.username : fallbackPlayerName(player.email), birthDate: typeof data?.birthDate === 'string' ? data.birthDate : null, bio: typeof data?.bio === 'string' ? data.bio : '', avatarType: data?.avatarType ?? null, avatarId: data?.avatarId ?? null, avatarUrl: await profileAvatarUrl(typeof data?.avatarKey === 'string' ? data.avatarKey : undefined), avatarRemoved: moderation.data()?.status === 'removed' });
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'Could not load profile.' }, 401); }
}

export async function PUT(request: Request) {
  try {
    if (!adminDb && !isDevProfileWriter()) throw new Error('Player profile service is not configured.');
    const player = await requirePlayer(request);
    const { username, birthDate, bio } = await request.json();
    const cleanUsername = typeof username === 'string' ? username.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
    if (!usernamePattern.test(cleanUsername)) throw new Error('Username must be 2–24 letters, numbers, spaces, hyphens, or underscores.');
    if (birthDate !== null && !validBirthDate(birthDate)) throw new Error('Enter a valid birth date that is not in the future.');
    if (bio !== undefined && (typeof bio !== 'string' || bio.length > 280)) throw new Error('INVALID_BIO');
    const usernameLower = cleanUsername.toLocaleLowerCase();
    if (isDevProfileWriter()) {
      try { return json(await updateProfile(player.id, cleanUsername, birthDate ?? null, bio === undefined ? undefined : bio.trim(), player.emailVerified ? emailSearchKey(player.email) : null)); }
      catch (error) { if (error instanceof Error && error.message === 'USERNAME_TAKEN') throw new UsernameTakenError('Username is already taken.'); throw error; }
    }
    const profiles = adminDb!.collection('playerProfiles');
    const claims = adminDb!.collection('playerUsernameClaims');
    const matches = await profiles.where('usernameLower', '==', usernameLower).limit(2).get();
    if (matches.docs.some((doc) => doc.id !== player.id)) throw new UsernameTakenError('Username is already taken.');
    const profile = { username: cleanUsername, usernameLower, birthDate: birthDate ?? null, ...(bio === undefined ? {} : { bio: bio.trim() }), emailSearchHash: player.emailVerified ? emailSearchKey(player.email) : FieldValue.delete(), updatedAt: new Date() };
    const profileRef = profiles.doc(player.id);
    const requestedClaimRef = claims.doc(usernameLower);
    await adminDb!.runTransaction(async (transaction) => {
      const current = await transaction.get(profileRef);
      const requestedClaim = await transaction.get(requestedClaimRef);
      const previousUsername = current.data()?.username;
      const previousLower = typeof previousUsername === 'string' ? previousUsername.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase() : '';
      const previousClaimRef = previousLower && previousLower !== usernameLower ? claims.doc(previousLower) : null;
      const previousClaim = previousClaimRef ? await transaction.get(previousClaimRef) : null;
      if (requestedClaim.exists && requestedClaim.data()?.playerId !== player.id) throw new UsernameTakenError('Username is already taken.');
      transaction.set(requestedClaimRef, { playerId: player.id });
      transaction.set(profileRef, profile, { merge: true });
      if (previousClaimRef && previousClaim?.data()?.playerId === player.id) transaction.delete(previousClaimRef);
    });
    return json({ username: profile.username, birthDate: profile.birthDate, ...(bio === undefined ? {} : { bio: profile.bio }) });
  } catch (error) {
    if (error instanceof UsernameTakenError) return json({ code: 'username_taken', error: error.message }, 409);
    return json({ error: error instanceof Error ? error.message : 'Could not save profile.' }, 400);
  }
}
