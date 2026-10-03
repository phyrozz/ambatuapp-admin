import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/api-auth';
import { removeAdminUser } from '../../../../lib/cognito-admins';
import { saveStudioUser, studioDb, validId } from '../../../../lib/studio-access';
import { studioError } from '../../../../lib/studio-api';
import { validateProfile } from '../../../../lib/studio-policy.mjs';
type Context = { params: Promise<{ id: string }> };
export const runtime = 'nodejs';
export async function PATCH(request: Request, context: Context) {
  try {
    const actor = await requireAdmin(request), sub = validId((await context.params).id), body = await request.json();
    const roleId = body.roleId === null ? null : validId(body.roleId);
    await saveStudioUser(sub, { ...validateProfile(body), roleId }, actor);
    return NextResponse.json({ saved: true });
  } catch (error) { return studioError(error); }
}
export async function DELETE(request: Request, context: Context) {
  try {
    const actor = await requireAdmin(request), sub = validId((await context.params).id);
    const target = (await studioDb().collection('studioUsers').doc(sub).get()).data();
    if (!target) throw new Error('studio.errors.userMissing');
    // Disable Firestore access first; even a stale Cognito token then loses access.
    await saveStudioUser(sub, { enabled: false, roleId: null }, actor);
    await removeAdminUser(target.username);
    return NextResponse.json({ removed: true });
  } catch (error) { return studioError(error); }
}
