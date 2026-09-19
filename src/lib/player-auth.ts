import { CognitoJwtVerifier } from 'aws-jwt-verify';

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

export async function playerFromRequest(request: Request) {
  const poolId = process.env.COGNITO_PLAYER_USER_POOL_ID;
  const clientId = process.env.COGNITO_PLAYER_CLIENT_ID;
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!poolId || !clientId) throw new Error('Player authentication is not configured.');
  if (!token) return null;
  verifier ??= CognitoJwtVerifier.create({ userPoolId: poolId, clientId, tokenUse: 'id' });
  const claims = await verifier.verify(token);
  return {
    id: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : 'Signed-in player',
  };
}

export async function requirePlayer(request: Request) {
  const player = await playerFromRequest(request);
  if (!player) throw new Error('Sign in to upload a video.');
  return player;
}
