import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../lib/api-auth';
import { listChatReports } from '../../../lib/chat-reports';

export async function GET(request: Request) {
  try { await requireAdmin(request); return NextResponse.json(await listChatReports(), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load reports.' }, { status: 403 }); }
}
