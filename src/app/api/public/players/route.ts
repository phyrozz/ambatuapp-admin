import { NextResponse } from 'next/server';
import { adminDb } from '../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../lib/player-auth';
import { profileAvatarUrl } from '../../../../lib/profile-avatars';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function GET(request: Request) {
  try {
    if (!adminDb) throw new Error('Player profiles are unavailable.');
    const player = await requirePlayer(request);
    const query = new URL(request.url).searchParams.get('q')?.normalize('NFKC').trim().toLocaleLowerCase() ?? '';
    if (query.length < 2 || query.length > 24) return NextResponse.json({ players: [] }, { headers });
    const snapshot = await adminDb.collection('playerProfiles').where('usernameLower', '>=', query).where('usernameLower', '<=', `${query}\uf8ff`).limit(15).get();
    const players = await Promise.all(snapshot.docs.filter(doc => doc.id !== player.id).map(async doc => ({ id: doc.id, username: doc.data().username, avatarUrl: await profileAvatarUrl(typeof doc.data().avatarKey === 'string' ? doc.data().avatarKey : undefined) })));
    return NextResponse.json({ players }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Search failed.' }, { status: 401, headers });
  }
}
