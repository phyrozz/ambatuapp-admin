import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { isCurrentAdmin } from './cognito-admins';
import { getStudioAccess } from './studio-access';
import { canAccess, permissionForRequest, type ModuleId, type RoleType } from './studio-policy.mjs';

export type AdminIdentity = { sub: string; username: string };

export async function requireStudioIdentity(request: Request) {
  const poolId = process.env.COGNITO_ADMIN_USER_POOL_ID || process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
  const clientId = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID;
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  // Keep the local preview usable, but never let a production deployment fail open.
  if (!poolId || !clientId) {
    if (process.env.NODE_ENV !== 'production') return;
    throw new Error('studio.errors.authConfiguration');
  }
  if (!token) throw new Error('studio.errors.unauthorized');
  const verifier = CognitoJwtVerifier.create({ userPoolId: poolId, tokenUse: 'id', clientId });
  const payload = await verifier.verify(token).catch(() => { throw new Error('studio.errors.unauthorized'); });
  const username = payload['cognito:username'];
  if (typeof username !== 'string') throw new Error('studio.errors.unauthorized');
  return { sub: payload.sub, username, email: typeof payload.email === 'string' ? payload.email : '', emailVerified: payload.email_verified === true };
}

export async function requireAdmin(request: Request, permission?: { module: ModuleId; action: RoleType }) {
  const identity = await requireStudioIdentity(request);
  if (!identity) return; // Unconfigured development preview only.
  if (!await isCurrentAdmin(identity.username)) throw new Error('studio.errors.forbidden');
  const access = await getStudioAccess(identity.sub);
  const required = permission ?? permissionForRequest(new URL(request.url).pathname, request.method);
  if (required && !canAccess(access.permissions, required.module, required.action)) throw new Error('studio.errors.forbidden');
  return { ...identity, ...access };
}
