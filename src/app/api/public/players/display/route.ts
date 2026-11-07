import { NextResponse } from 'next/server';
import { POST as names, OPTIONS } from '../names/route';
export { OPTIONS };

export async function POST(request: Request) {
  let body;
  try { body = await request.json(); } catch { body = null; }
  if (!Array.isArray(body?.ids) || body.ids.length > 50) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400, headers: {
      'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store',
    } });
  }
  return names(new Request(request, { body: JSON.stringify(body) }));
}
