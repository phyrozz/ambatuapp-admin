import { NextResponse } from 'next/server';
import { requirePlayer } from '../../../../../lib/player-auth';
import { isDevSocialWriter } from '../../../../../lib/dev-content-db';
import { validFriendId } from '../../../../../lib/friend-list';
import { changePlayerBlock } from '../../../../../lib/player-blocks';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'PUT, DELETE, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }
async function change(request: Request, params: Promise<{ id: string }>, blocked: boolean) {
  let player;
  try { player = await requirePlayer(request); } catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  const { id } = await params;
  if (!validFriendId(id) || id === player.id) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400, headers });
  try {
    if (!isDevSocialWriter()) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers });
    return NextResponse.json(await changePlayerBlock(player.id, id, blocked), { headers });
  } catch { return NextResponse.json({ error: 'BLOCK_UPDATE_FAILED' }, { status: 503, headers }); }
}
export function PUT(request: Request, context: { params: Promise<{ id: string }> }) { return change(request, context.params, true); }
export function DELETE(request: Request, context: { params: Promise<{ id: string }> }) { return change(request, context.params, false); }
