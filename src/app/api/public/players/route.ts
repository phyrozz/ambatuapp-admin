import { NextResponse } from 'next/server';
import { isDevProfileWriter } from '../../../../lib/dev-content-db';
import { searchProfiles, getDisplayProfiles } from '../../../../lib/dev-profiles';
import { adminDb } from '../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../lib/player-auth';
import { profileAvatarUrl } from '../../../../lib/profile-avatars';
import { hiddenPlayerIds } from '../../../../lib/player-blocks';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function GET(request: Request) {
  try {
    if (!adminDb && !isDevProfileWriter()) throw new Error('Player profiles are unavailable.');
    const player = await requirePlayer(request);
    const query = new URL(request.url).searchParams.get('q')?.normalize('NFKC').trim().toLocaleLowerCase() ?? '';
    if (query.length < 2 || query.length > 24) return NextResponse.json({ players: [] }, { headers });
    if (isDevProfileWriter()) {
      const candidates = (await searchProfiles('username', query, null)).slice(0, 15);
      const hidden = await hiddenPlayerIds(player.id, candidates.map(row => row.id));
      const rows = candidates.filter(row => row.id !== player.id && !hidden.has(row.id));
      const display = await getDisplayProfiles(rows.map(row => row.id), new Map());
      return NextResponse.json({ players: rows.map(row => ({ id: row.id, ...display.get(row.id) })) }, { headers });
    }
    const snapshot = await adminDb!.collection('playerProfiles').where('usernameLower', '>=', query).where('usernameLower', '<=', `${query}\uf8ff`).limit(15).get();
    const hidden = await hiddenPlayerIds(player.id, snapshot.docs.map(doc => doc.id));
    const players = await Promise.all(snapshot.docs.filter(doc => doc.id !== player.id && !hidden.has(doc.id)).map(async doc => ({ id: doc.id, username: doc.data().username, avatarUrl: await profileAvatarUrl(typeof doc.data().avatarKey === 'string' ? doc.data().avatarKey : undefined) })));
    return NextResponse.json({ players }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Search failed.' }, { status: 401, headers });
  }
}
