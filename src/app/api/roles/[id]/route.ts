import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/api-auth';
import { deleteRole, saveRole } from '../../../../lib/studio-access';
import { studioError } from '../../../../lib/studio-api';
type Context = { params: Promise<{ id: string }> };
export const runtime = 'nodejs';
export async function PATCH(request: Request, context: Context) {
  try { await requireAdmin(request); return NextResponse.json(await saveRole(await request.json(), (await context.params).id)); }
  catch (error) { return studioError(error); }
}
export async function DELETE(request: Request, context: Context) {
  try { await requireAdmin(request); await deleteRole((await context.params).id); return NextResponse.json({ deleted: true }); }
  catch (error) { return studioError(error); }
}
