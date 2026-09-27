import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../lib/firebase-admin';
import { soundAudioUrl, soundResponse } from '../../../../../lib/admin-sounds';
import { validSoundAssetKey } from '../../../../../lib/s3-sounds';

export const runtime = 'nodejs';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'no-store',
};

export function OPTIONS() {
  return new NextResponse(null, { headers });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!adminDb) return NextResponse.json({ error: 'Sound catalog is not configured.' }, { status: 503, headers });
  try {
    const { id } = await params;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return NextResponse.json({ error: 'Sound not found.' }, { status: 404, headers });
    const snapshot = await adminDb.collection('soundboardSounds').doc(id).get();
    const data = snapshot.data();
    if (!snapshot.exists || !data || !validSoundAssetKey(data.soundKey) || typeof data.name !== 'string' || typeof data.category !== 'string') {
      return NextResponse.json({ error: 'Sound not found.' }, { status: 404, headers });
    }
    const sound = soundResponse(id, data, soundAudioUrl(new URL(request.url).origin, id));
    return NextResponse.json({ sound: { id: sound.id, name: sound.name, category: sound.category, color: sound.color, file: sound.audioUrl, createdAt: sound.createdAt, playCount: sound.playCount } }, { headers });
  } catch {
    return NextResponse.json({ error: 'Could not load the sound.' }, { status: 503, headers });
  }
}
