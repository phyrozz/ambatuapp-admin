import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../lib/api-auth';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    return NextResponse.json({ authorized: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not verify administrator access.';
    const status = message === 'Unauthorized' ? 401 : message === 'Admin authentication is not configured.' ? 503 : 403;
    return NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
