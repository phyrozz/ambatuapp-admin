import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/api-auth';
import { readApiRateLimitSettings, saveApiRateLimitSettings } from '../../../../lib/api-rate-limit-settings';
import { adminDb } from '../../../../lib/firebase-admin';
import { studioError } from '../../../../lib/studio-api';

const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  try {
    await requireAdmin(request, { module: 'settings', action: 'view' });
    return NextResponse.json(await readApiRateLimitSettings(adminDb), { headers });
  } catch (error) { return studioError(error); }
}

export async function PUT(request: Request) {
  try {
    const actor = await requireAdmin(request, { module: 'settings', action: 'edit' });
    const body = await request.json();
    return NextResponse.json(await saveApiRateLimitSettings(adminDb, body?.enabled, body?.version, actor?.sub ?? 'local-preview'), { headers });
  } catch (error) { return studioError(error); }
}
