import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../lib/api-auth';
import { studioError } from '../../../lib/studio-api';
import { rootPermissions } from '../../../lib/studio-policy.mjs';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const identity = await requireAdmin(request);
    return NextResponse.json({ authorized: true, permissions: identity?.permissions ?? rootPermissions(), roleId: identity?.roleId ?? 'root', roleName: identity?.roleName ?? null, profile: identity?.profile ?? null }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return studioError(error);
  }
}
