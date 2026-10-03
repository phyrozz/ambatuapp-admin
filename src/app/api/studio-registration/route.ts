import { NextResponse } from 'next/server';
import { requireStudioIdentity } from '../../../lib/api-auth';
import { addStudioMembership, isCurrentAdmin } from '../../../lib/cognito-admins';
import { saveStudioUser, studioDb } from '../../../lib/studio-access';
import { studioError } from '../../../lib/studio-api';
import { validateProfile } from '../../../lib/studio-policy.mjs';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const identity = await requireStudioIdentity(request);
    if (!identity || !identity.emailVerified || !identity.email) throw new Error('studio.errors.verifyEmail');
    const profile = validateProfile(await request.json());
    const existing = (await studioDb().collection('studioUsers').doc(identity.sub).get()).data();
    if (existing && !existing.enabled) throw new Error('studio.errors.forbidden');
    // Registration must not restore group access deliberately revoked from an existing user.
    if (existing && existing.registrationPending !== true) {
      if (!await isCurrentAdmin(identity.username)) throw new Error('studio.errors.forbidden');
      return NextResponse.json({ registered: true });
    }
    if (!existing) {
      // No client-supplied role or permissions can enter the registration record.
      await saveStudioUser(identity.sub, { ...profile, sub: identity.sub, username: identity.username, email: identity.email, enabled: true, roleId: null, registrationPending: true }, undefined, true);
    }
    await addStudioMembership(identity.username);
    await studioDb().collection('studioUsers').doc(identity.sub).update({ registrationPending: false });
    return NextResponse.json({ registered: true });
  } catch (error) { return studioError(error); }
}
