import { NextResponse } from 'next/server';
import { requirePlayer } from '../../../../lib/player-auth';
import { isDevSocialWriter } from '../../../../lib/dev-content-db';
import { validFriendId } from '../../../../lib/friend-list';
import { listPlayerBlocks } from '../../../../lib/player-blocks';
import { playerDisplayProfiles } from '../../../../lib/player-profiles';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }
export async function GET(request: Request) {
  let player;
  try { player = await requirePlayer(request); } catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  const cursor = new URL(request.url).searchParams.get('cursor');
  if (cursor && !validFriendId(cursor)) return NextResponse.json({ error: 'INVALID_CURSOR' }, { status: 400, headers });
  try {
    if (!isDevSocialWriter()) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers });
    const page = await listPlayerBlocks(player.id, cursor);
    // Owner-only management: never expose this exception through public profile reads.
    const profiles = await playerDisplayProfiles(page.items.map(item => item.id), new Map());
    return NextResponse.json({ ...page, items: page.items.map(item => ({ ...item, ...profiles.get(item.id) })) }, { headers });
  } catch { return NextResponse.json({ error: 'BLOCKS_UNAVAILABLE' }, { status: 503, headers }); }
}
