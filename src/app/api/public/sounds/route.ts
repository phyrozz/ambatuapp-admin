import { NextResponse } from 'next/server';
import { adminDb } from '../../../../lib/firebase-admin';
import { soundAudioUrl, soundResponse } from '../../../../lib/admin-sounds';
import { validSoundAssetKey } from '../../../../lib/s3-sounds';

export const runtime = 'nodejs';
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'public, max-age=60',
};

export function OPTIONS() {
  return new NextResponse(null, { headers });
}

export async function GET(request: Request) {
  if (!adminDb) return NextResponse.json({ error: 'Sound catalog is not configured.' }, { status: 503, headers });
  try {
    const snapshot = await adminDb.collection('soundboardSounds').get();
    const origin = new URL(request.url).origin;
    const sounds = snapshot.docs
      .filter(doc => validSoundAssetKey(doc.data().soundKey) && typeof doc.data().name === 'string' && typeof doc.data().category === 'string')
      .map(doc => {
        const sound = soundResponse(doc.id, doc.data(), soundAudioUrl(origin, doc.id));
        return { id: sound.id, name: sound.name, category: sound.category, color: sound.color, file: sound.audioUrl };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ sounds }, { headers });
  } catch {
    return NextResponse.json({ error: 'Could not load sounds.' }, { status: 503, headers });
  }
}
