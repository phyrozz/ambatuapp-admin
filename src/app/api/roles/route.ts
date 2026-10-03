import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../lib/api-auth';
import { listStudioRecords, saveRole } from '../../../lib/studio-access';
import { studioError } from '../../../lib/studio-api';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    return NextResponse.json(await listStudioRecords('studioRoles', new URL(request.url).searchParams.get('cursor')), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return studioError(error); }
}
export async function POST(request: Request) {
  try { await requireAdmin(request); return NextResponse.json(await saveRole(await request.json()), { status: 201 }); }
  catch (error) { return studioError(error); }
}
