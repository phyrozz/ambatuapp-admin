import { FieldPath } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../lib/firebase-admin';
import { soundAudioUrl, soundResponse } from '../../../../lib/admin-sounds';
import { validSoundAssetKey } from '../../../../lib/s3-sounds';

export const runtime = 'nodejs';
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'no-store',
};

export function OPTIONS() {
  return new NextResponse(null, { headers });
}

export async function GET(request: Request) {
  if (!adminDb) return NextResponse.json({ error: 'Sound catalog is not configured.' }, { status: 503, headers });
  try {
    const url = new URL(request.url);
    const paginated = url.searchParams.has('limit') || url.searchParams.has('cursor');
    const requestedLimit = Number(url.searchParams.get('limit')) || 12;
    const limit = Math.min(50, Math.max(1, Math.floor(requestedLimit)));
    const encodedCursor = url.searchParams.get('cursor');
    let cursor: { name: string; id: string } | null = null;
    if (encodedCursor) {
      try {
        const parsed = JSON.parse(Buffer.from(encodedCursor, 'base64url').toString('utf8')) as Record<string, unknown>;
        if (typeof parsed.name !== 'string' || typeof parsed.id !== 'string') throw new Error('Invalid cursor');
        cursor = { name: parsed.name, id: parsed.id };
      } catch {
        return NextResponse.json({ error: 'Invalid sound catalog cursor.' }, { status: 400, headers });
      }
    }
    const collection = adminDb.collection('soundboardSounds');
    let query = collection
      .orderBy('name')
      .orderBy(FieldPath.documentId())
      .limit(limit + 1);
    if (cursor) query = query.startAfter(cursor.name, cursor.id);
    const snapshot = paginated ? await query.get() : await collection.get();
    const page = paginated ? snapshot.docs.slice(0, limit) : snapshot.docs;
    const origin = new URL(request.url).origin;
    const sounds = page
      .filter(doc => validSoundAssetKey(doc.data().soundKey) && typeof doc.data().name === 'string' && typeof doc.data().category === 'string')
      .map(doc => {
        const sound = soundResponse(doc.id, doc.data(), soundAudioUrl(origin, doc.id));
        return { id: sound.id, name: sound.name, category: sound.category, color: sound.color, file: sound.audioUrl, createdAt: sound.createdAt, playCount: sound.playCount };
      });
    if (!paginated) sounds.sort((a, b) => a.name.localeCompare(b.name));
    const last = page.at(-1);
    const nextCursor = paginated && snapshot.docs.length > limit && last && typeof last.data().name === 'string'
      ? Buffer.from(JSON.stringify({ name: last.data().name, id: last.id })).toString('base64url')
      : null;
    return NextResponse.json({ sounds, nextCursor }, { headers });
  } catch {
    return NextResponse.json({ error: 'Could not load sounds.' }, { status: 503, headers });
  }
}
