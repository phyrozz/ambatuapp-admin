import { NextResponse } from 'next/server';
import { isDevVideoWriter } from '../../../../lib/dev-content-db';
import { listPersonalizedScroll } from '../../../../lib/personalized-scroll';
import { requirePlayer } from '../../../../lib/player-auth';
import { parseScrollRefresh } from '../../../../lib/scroll-ranking';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }
export async function GET(request: Request) {
  let player;
  try { player = await requirePlayer(request); } catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  try {
    if (!isDevVideoWriter()) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers });
    const params = new URL(request.url).searchParams;
    const raw = params.get('cursor');
    return NextResponse.json(await listPersonalizedScroll(player.id, raw, raw ? undefined : parseScrollRefresh(params)), { headers });
  } catch (error) {
    const invalid = error instanceof Error && ['INVALID_CURSOR', 'INVALID_REFRESH'].includes(error.message);
    return NextResponse.json({ error: invalid ? error.message : 'SCROLL_UNAVAILABLE' }, { status: invalid ? 400 : 500, headers });
  }
}
