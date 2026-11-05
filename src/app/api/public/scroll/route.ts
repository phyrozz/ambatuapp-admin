import { NextResponse } from 'next/server';
import { isDevVideoWriter } from '../../../../lib/dev-content-db';
import { listPersonalizedScroll } from '../../../../lib/personalized-scroll';
import { requirePlayer } from '../../../../lib/player-auth';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }
export async function GET(request: Request) {
  let player;
  try { player = await requirePlayer(request); } catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  try {
    if (!isDevVideoWriter()) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers });
    const raw = new URL(request.url).searchParams.get('cursor');
    return NextResponse.json(await listPersonalizedScroll(player.id, raw), { headers });
  } catch (error) {
    const invalid = error instanceof Error && error.message === 'INVALID_CURSOR';
    return NextResponse.json({ error: invalid ? 'INVALID_CURSOR' : 'SCROLL_UNAVAILABLE' }, { status: invalid ? 400 : 500, headers });
  }
}
