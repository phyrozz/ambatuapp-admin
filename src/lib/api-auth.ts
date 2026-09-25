import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { ADMIN_GROUP_NAME } from './admin-constants';
import { isCurrentAdmin } from './cognito-admins';

export type AdminIdentity = { sub: string; username: string };

export async function requireAdmin(request: Request) {
  const poolId = process.env.COGNITO_ADMIN_USER_POOL_ID || process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
  const clientId = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID;
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  // Keep the local preview usable, but never let a production deployment fail open.
  if (!poolId || !clientId) {
    if (process.env.NODE_ENV !== 'production') return;
    throw new Error('Admin authentication is not configured.');
  }
  if (!token) throw new Error('Unauthorized');
  const verifier = CognitoJwtVerifier.create({ userPoolId: poolId, tokenUse: 'id', clientId });
  const payload = await verifier.verify(token);
  const groups = payload['cognito:groups'];
  const username = payload['cognito:username'];
  if (!Array.isArray(groups) || !groups.includes(ADMIN_GROUP_NAME) || typeof username !== 'string' || !await isCurrentAdmin(username)) {
    throw new Error('Administrator access is required.');
  }
  return { sub: payload.sub, username } satisfies AdminIdentity;
}
