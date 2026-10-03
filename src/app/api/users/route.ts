import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../lib/api-auth';
import { createStudioCognitoUser, deleteStudioCognitoUser } from '../../../lib/cognito-admins';
import { listStudioRecords, saveStudioUser, studioDb, validId } from '../../../lib/studio-access';
import { studioError } from '../../../lib/studio-api';
import { validateCredentials, validateProfile } from '../../../lib/studio-policy.mjs';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try { await requireAdmin(request); return NextResponse.json(await listStudioRecords('studioUsers', new URL(request.url).searchParams.get('cursor')), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return studioError(error); }
}
export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request), body = await request.json();
    const profile = validateProfile(body), { email, password } = validateCredentials(body), roleId = validId(body.roleId);
    if (roleId === 'root' && actor?.roleId !== 'root') throw new Error('studio.errors.rootAssignment');
    if (!(await studioDb().collection('studioRoles').doc(roleId).get()).exists) throw new Error('studio.errors.roleMissing');
    const user = await createStudioCognitoUser(email, password);
    try { await saveStudioUser(user.sub, { ...profile, ...user, roleId, enabled: true }, actor, true); }
    catch (error) { await deleteStudioCognitoUser(user.username); throw error; }
    return NextResponse.json({ ...profile, ...user, roleId, enabled: true }, { status: 201 });
  } catch (error) { return studioError(error); }
}
