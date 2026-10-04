import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../../lib/player-auth';
import { validFriendId } from '../../../../../lib/friend-list';
import { creatorHeaders as headers, creatorProfile } from '../../../../../lib/creator-profile';

export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let player;
  try { player = await requirePlayer(request); } catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  const { id } = await params;
  if (!validFriendId(id) || id === 'admin') return NextResponse.json({ error: 'PLAYER_NOT_FOUND' }, { status: 404, headers });
  if (!adminDb) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers });
  try { return NextResponse.json(await creatorProfile(adminDb, id, player.id), { headers }); }
  catch (error) { return NextResponse.json({ error: 'PROFILE_UNAVAILABLE' }, { status: error instanceof Error && error.message === 'PLAYER_NOT_FOUND' ? 404 : 500, headers }); }
}
