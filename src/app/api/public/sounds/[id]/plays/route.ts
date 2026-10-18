import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../../lib/firebase-admin';
import { isPublicSound } from '../../../../../../lib/admin-sounds';
import { playerFromRequest } from '../../../../../../lib/player-auth';
import { allowPlayerWrite } from '../../../../../../lib/public-write-limits';
import { validSoundAssetKey } from '../../../../../../lib/s3-sounds';

export const runtime = 'nodejs';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};

export function OPTIONS() {
  return new NextResponse(null, { headers });
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!adminDb) return NextResponse.json({ error: 'Sound catalog is not configured.' }, { status: 503, headers });

  let player: Awaited<ReturnType<typeof playerFromRequest>>;
  if (_request.headers.has('authorization')) {
    try {
      player = await playerFromRequest(_request);
    } catch {
      return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers });
    }
  } else {
    player = null;
  }

  try {
    let visitorId: string | null = null;
    if (!player) {
      try {
        const body = await _request.json() as { visitorId?: unknown };
        visitorId = typeof body.visitorId === 'string' ? body.visitorId : null;
      } catch {
        return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers });
      }
      if (!visitorId || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(visitorId)) {
        return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers });
      }
    }
    const identity = player ? `player:${player.id}` : `guest:${visitorId}`;
    const { id } = await params;
    const sound = adminDb.collection('soundboardSounds').doc(id);
    const snapshot = await sound.get();
    const data = snapshot.data();
    if (!snapshot.exists || !data || !isPublicSound(data) || !validSoundAssetKey(data.soundKey) || typeof data.name !== 'string' || typeof data.category !== 'string') {
      return NextResponse.json({ error: 'Sound not found.' }, { status: 404, headers });
    }

    if (!await allowPlayerWrite(adminDb, identity, 'soundPlays', [{ key: 'minute', max: 60, windowMs: 60_000 }])) {
      return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429, headers });
    }

    if (data.source === 'revamp' && typeof data.uploaderId === 'string' && player?.id !== data.uploaderId) {
      const listenerKey = createHash('sha256').update(identity).digest('hex');
      const listener = sound.collection('creatorListeners').doc(listenerKey);
      try {
        await adminDb.runTransaction(async transaction => {
          const [latest, prior] = await Promise.all([transaction.get(sound), transaction.get(listener)]);
          const latestData = latest.data();
          if (!latest.exists || !latestData || !isPublicSound(latestData) || prior.exists) return;
          transaction.create(listener, { listenedAt: FieldValue.serverTimestamp() });
          transaction.update(sound, { listenerCount: FieldValue.increment(1) });
        });
      } catch {
        // Listener totals are best-effort; the play counter remains authoritative.
      }
    }

    await sound.update({ playCount: FieldValue.increment(1) });
    const updated = (await sound.get()).data();
    const playCount = typeof updated?.playCount === 'number' && Number.isSafeInteger(updated.playCount) && updated.playCount >= 0
      ? updated.playCount
      : 1;
    return NextResponse.json({ playCount }, { headers });
  } catch {
    return NextResponse.json({ error: 'Could not record the sound play.' }, { status: 503, headers });
  }
}
