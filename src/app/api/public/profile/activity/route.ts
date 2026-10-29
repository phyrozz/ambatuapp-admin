import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '../../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../../lib/player-auth';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const ACTIVITY_INTERVAL_MS = 15 * 60 * 1000;

export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function POST(request: Request) {
  let player;
  try {
    player = await requirePlayer(request);
  } catch {
    return NextResponse.json({ ok: false }, { status: 401, headers });
  }
  if (!adminDb) return NextResponse.json({ ok: false }, { status: 503, headers });
  try {
    const profile = adminDb.collection('playerProfiles').doc(player.id);
    await adminDb.runTransaction(async transaction => {
      const snapshot = await transaction.get(profile);
      if (!snapshot.exists) return;
      const lastActive = snapshot.data()?.lastActiveAt?.toMillis?.();
      if (typeof lastActive !== 'number' || Date.now() - lastActive >= ACTIVITY_INTERVAL_MS) {
        transaction.update(profile, { lastActiveAt: FieldValue.serverTimestamp() });
      }
    });
    return NextResponse.json({ ok: true }, { headers });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503, headers });
  }
}
