import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/api-auth';
import { listStudioRecords } from '../../../../lib/studio-access';
import { studioError } from '../../../../lib/studio-api';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    // Users managers need role choices without needing access to the Roles page.
    const identity = await requireAdmin(request, { module: 'users', action: 'view' });
    const result = await listStudioRecords('studioRoles', new URL(request.url).searchParams.get('cursor'));
    return NextResponse.json({ ...result, items: result.items.filter(item => item.id !== 'root' || identity?.roleId === 'root').map(item => ({ id: item.id, name: 'name' in item ? item.name : '' })) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return studioError(error); }
}
