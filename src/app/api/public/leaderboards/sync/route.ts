import { NextResponse } from 'next/server';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '../../../../../lib/firebase-admin';

export const runtime = 'nodejs';
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const gameIds = ['ambatutap', 'ambatusnake', 'ambatublou', 'flappy-bus'] as const;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers });
}

function accessVerifier() {
  const userPoolId = process.env.COGNITO_PLAYER_USER_POOL_ID;
  const clientId = process.env.COGNITO_PLAYER_CLIENT_ID;
  if (!userPoolId || !clientId) throw new Error('Player Cognito verification is not configured.');
  return CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'access' });
}

export function OPTIONS() {
  return new NextResponse(null, { headers });
}

export async function POST(request: Request) {
  try {
    if (!adminDb) return json({ error: 'Leaderboard service is not configured.' }, 503);
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'Sign in to sync scores.' }, 401);
    const claims = await accessVerifier().verify(token);
    const body = await request.json() as { scores?: unknown };
    const provided = body?.scores;
    if (!provided || typeof provided !== 'object' || Array.isArray(provided)) {
      return json({ error: 'Invalid scores.' }, 400);
    }

    const localScores: Partial<Record<(typeof gameIds)[number], number>> = {};
    for (const gameId of gameIds) {
      const score = (provided as Record<string, unknown>)[gameId];
      if (score === undefined) continue;
      if (!Number.isSafeInteger(score) || (score as number) < 0 || (score as number) > 1_000_000) {
        return json({ error: 'Invalid score.' }, 400);
      }
      localScores[gameId] = score as number;
    }

    const entries = gameIds.map((gameId) => adminDb!.collection('leaderboards').doc(gameId).collection('entries').doc(claims.sub));
    const scores = await adminDb.runTransaction(async (transaction) => {
      const existing = await Promise.all(entries.map((entry) => transaction.get(entry)));
      const merged: Record<string, number> = {};
      for (let index = 0; index < gameIds.length; index++) {
        const gameId = gameIds[index];
        const snapshot = existing[index];
        const storedScore = snapshot.data()?.score;
        const remoteScore = typeof storedScore === 'number' && Number.isSafeInteger(storedScore) && storedScore >= 0
          ? storedScore
          : 0;
        const bestScore = Math.max(remoteScore, localScores[gameId] ?? 0);
        merged[gameId] = bestScore;
        if (bestScore > remoteScore) {
          transaction.set(entries[index], {
            player: `Player ${claims.sub.slice(0, 6)}`,
            score: bestScore,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }
      }
      return merged;
    });
    return json({ scores });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Score sync failed.' }, 401);
  }
}
