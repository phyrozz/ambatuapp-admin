import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../../lib/firebase-admin';
import { validSoundAssetKey } from '../../../../../../lib/s3-sounds';

export const runtime = 'nodejs';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};

export function OPTIONS() {
  return new NextResponse(null, { headers });
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!adminDb) return NextResponse.json({ error: 'Sound catalog is not configured.' }, { status: 503, headers });

  try {
    const { id } = await params;
    const sound = adminDb.collection('soundboardSounds').doc(id);
    const snapshot = await sound.get();
    const data = snapshot.data();
    if (!snapshot.exists || !data || !validSoundAssetKey(data.soundKey) || typeof data.name !== 'string' || typeof data.category !== 'string') {
      return NextResponse.json({ error: 'Sound not found.' }, { status: 404, headers });
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
