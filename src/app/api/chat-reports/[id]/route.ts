import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/api-auth';
import { resolveChatReport } from '../../../../lib/chat-reports';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await requireAdmin(request); await resolveChatReport((await params).id); return NextResponse.json({ ok: true }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not resolve report.' }, { status: 403 }); }
}
