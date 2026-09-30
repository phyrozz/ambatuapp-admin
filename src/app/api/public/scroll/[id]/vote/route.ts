import { NextResponse } from 'next/server';
import { requirePlayer } from '../../../../../../lib/player-auth';
import { POST as voteOnVideo } from '../../../videos/[id]/vote/route';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try { await requirePlayer(request); } catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  return voteOnVideo(request, context);
}
