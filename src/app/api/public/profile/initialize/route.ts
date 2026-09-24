import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../../lib/player-auth';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};

export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function POST(request: Request) {
  try {
    if (!adminDb) throw new Error('Player profile service is not configured.');
    const player = await requirePlayer(request);
    const profiles = adminDb.collection('playerProfiles');
    const claims = adminDb.collection('playerUsernameClaims');
    const profileRef = profiles.doc(player.id);
    const existing = await profileRef.get();
    const existingUsername = existing.data()?.username;
    if (typeof existingUsername === 'string' && existingUsername.trim()) {
      if (existing.data()?.usernameLower !== existingUsername.toLocaleLowerCase()) {
        await adminDb.runTransaction(async transaction => {
          const current = await transaction.get(profileRef);
          const username = current.data()?.username;
          if (typeof username === 'string' && username.trim() && current.data()?.usernameLower !== username.toLocaleLowerCase()) {
            transaction.update(profileRef, { usernameLower: username.toLocaleLowerCase() });
          }
        });
      }
      const latest = await profileRef.get();
      return NextResponse.json({ username: latest.data()?.username, birthDate: latest.data()?.birthDate ?? null }, { headers });
    }

    // Reserve a random username so an email prefix cannot collide with a chosen one.
    for (let attempt = 0; attempt < 5; attempt++) {
      const username = `thughunter_${randomBytes(7).toString('hex').slice(0, 13)}`;
      const usernameLower = username.toLocaleLowerCase();
      const matches = await profiles.where('usernameLower', '==', usernameLower).limit(1).get();
      if (matches.docs.some(doc => doc.id !== player.id)) continue;
      const claimRef = claims.doc(usernameLower);
      const result = await adminDb.runTransaction(async transaction => {
        const [current, claim] = await Promise.all([transaction.get(profileRef), transaction.get(claimRef)]);
        const currentUsername = current.data()?.username;
        if (typeof currentUsername === 'string' && currentUsername.trim()) {
          return { username: currentUsername, birthDate: current.data()?.birthDate ?? null };
        }
        if (claim.exists && claim.data()?.playerId !== player.id) return null;
        transaction.set(claimRef, { playerId: player.id });
        const birthDate = current.data()?.birthDate ?? null;
        transaction.set(profileRef, { username, usernameLower, birthDate, updatedAt: new Date() }, { merge: true });
        return { username, birthDate };
      });
      if (result) return NextResponse.json(result, { headers });
    }
    throw new Error('Could not assign a unique username.');
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not initialize profile.' }, { status: 400, headers });
  }
}
