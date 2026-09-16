import { CognitoJwtVerifier } from 'aws-jwt-verify';

export async function requireAdmin(request: Request) {
  const poolId = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
  const clientId = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID;
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  // Local development remains available without Cognito; production must configure it.
  if (!poolId || !clientId) return;
  if (!token) throw new Error('Unauthorized');
  const verifier = CognitoJwtVerifier.create({ userPoolId: poolId, tokenUse: 'id', clientId });
  await verifier.verify(token);
}
