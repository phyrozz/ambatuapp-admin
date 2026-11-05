import { NextResponse } from 'next/server';
import { isDevVideoWriter } from '../../../../../../lib/dev-content-db';
import { requirePlayer } from '../../../../../../lib/player-auth';
import { recordScrollWatch } from '../../../../../../lib/personalized-scroll';
import { parseWatchSignal } from '../../../../../../lib/scroll-ranking';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  let player;
  try { player = await requirePlayer(request); } catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  const { id } = await context.params;
  if (!/^[\w-]{1,128}$/.test(id)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400, headers });
  let signal;
  try {
    const body = await request.text();
    if (body.length > 256) throw new Error();
    signal = parseWatchSignal(JSON.parse(body));
  } catch { return NextResponse.json({ error: 'INVALID_SIGNAL' }, { status: 400, headers }); }
  try {
    if (!isDevVideoWriter()) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers });
    const saved = await recordScrollWatch(player.id, id, signal);
    return NextResponse.json(saved ? { ok: true } : { error: 'NOT_FOUND' }, { status: saved ? 200 : 404, headers });
  } catch { return NextResponse.json({ error: 'SCROLL_UNAVAILABLE' }, { status: 500, headers }); }
}
