import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../../lib/player-auth';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }
export async function GET(request: Request) {
  let player;
  try { player = await requirePlayer(request); } catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  if (!adminDb) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers });
  try {
    const count = await adminDb.collection('playerProfiles').doc(player.id).collection('friends').where('state', '==', 'incoming').count().get();
    return NextResponse.json({ incomingCount: count.data().count }, { headers });
  } catch { return NextResponse.json({ error: 'FRIENDS_UNAVAILABLE' }, { status: 500, headers }); }
}
