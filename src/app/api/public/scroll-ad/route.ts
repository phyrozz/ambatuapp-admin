import { NextResponse } from 'next/server';
import { requirePlayer } from '../../../../lib/player-auth';
import { randomAd } from '../../../../lib/scroll-ads';
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }
export async function GET(request: Request) {
  try { await requirePlayer(request); } catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  try { const ad = await randomAd(); return NextResponse.json({ ad: ad && { id: ad.id, title: ad.title, imageUrl: ad.imageUrl, destinationUrl: ad.destinationUrl } }, { headers }); }
  catch { return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers }); }
}
