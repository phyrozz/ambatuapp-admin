import { NextResponse } from 'next/server';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '../../../../../lib/firebase-admin';
import { playerDisplayProfiles } from '../../../../../lib/player-profiles';

export const runtime = 'nodejs';
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const gameIds = new Set(['ambatutap', 'ambatusnake', 'ambatublou', 'flappy-bus']);

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

export async function GET(_request: Request, { params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;
  if (!gameIds.has(gameId)) return json({ error: 'Unknown game.' }, 404);
  if (!adminDb) return json({ error: 'Leaderboard service is not configured.' }, 503);
  const snapshot = await adminDb.collection('leaderboards').doc(gameId).collection('entries').orderBy('score', 'desc').orderBy('updatedAt', 'asc').limit(20).get();
  const profiles = await playerDisplayProfiles(snapshot.docs.map((doc) => doc.id), new Map(snapshot.docs.map((doc) => [doc.id, doc.data().player ?? 'Player'])));
  return json({ entries: snapshot.docs.map((doc, index) => {
    const entry = doc.data();
    const profile = profiles.get(doc.id);
    return { rank: index + 1, player: profile?.username ?? entry.player, avatarUrl: profile?.avatarUrl ?? null, score: entry.score, updatedAt: entry.updatedAt?.toDate?.().toISOString() ?? null };
  }) });
}

export async function POST(request: Request, { params }: { params: Promise<{ gameId: string }> }) {
  try {
    const { gameId } = await params;
    if (!gameIds.has(gameId)) return json({ error: 'Unknown game.' }, 404);
    if (!adminDb) return json({ error: 'Leaderboard service is not configured.' }, 503);
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'Sign in to submit a score.' }, 401);
    const claims = await accessVerifier().verify(token);
    const { score } = await request.json();
    if (!Number.isSafeInteger(score) || score < 0 || score > 1_000_000) return json({ error: 'Invalid score.' }, 400);
    const entry = adminDb.collection('leaderboards').doc(gameId).collection('entries').doc(claims.sub);
    await adminDb.runTransaction(async transaction => {
      const current = await transaction.get(entry);
      if (!current.exists || score > current.data()?.score) {
        transaction.set(entry, { player: `Player ${claims.sub.slice(0, 6)}`, score, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
    });
    return json({ ok: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Score submission failed.' }, 401);
  }
}
