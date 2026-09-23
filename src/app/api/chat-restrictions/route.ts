import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../lib/api-auth';
import { setChatRestriction } from '../../../lib/chat-reports';

export async function PATCH(request: Request) {
  try {
    await requireAdmin(request);
    const body = await request.json();
    if (typeof body?.userId !== 'string' || typeof body?.restricted !== 'boolean') throw new Error('Invalid restriction request.');
    const restriction = await setChatRestriction(body.userId, body.restricted, typeof body.reportId === 'string' ? body.reportId : undefined);
    return NextResponse.json({ restriction }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not update chat restriction.' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
}
