import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../../lib/player-auth';
import { playerDisplayProfiles } from '../../../../../lib/player-profiles';
import { validFriendId } from '../../../../../lib/friend-list';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  let player;
  try { player = await requirePlayer(request); } catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  const { id } = await context.params;
  if (!validFriendId(id)) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400, headers });
  const db = adminDb;
  if (!db) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers });
  try {
    const [target, relationship] = await Promise.all([db.collection('playerProfiles').doc(id).get(), db.collection('playerProfiles').doc(player.id).collection('friends').doc(id).get()]);
    if (!target.exists) return NextResponse.json({ error: 'PLAYER_NOT_FOUND' }, { status: 404, headers });
    const profile = (await playerDisplayProfiles([id], new Map())).get(id);
    return NextResponse.json({ friend: { id, ...profile, state: relationship.data()?.state ?? null, pinned: relationship.data()?.pinned === true } }, { headers });
  } catch { return NextResponse.json({ error: 'FRIENDS_UNAVAILABLE' }, { status: 500, headers }); }
}
