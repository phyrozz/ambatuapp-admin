import { NextResponse } from 'next/server';
import { adminDb } from '../../../../lib/firebase-admin';
import { characterImageKey, signedCharacterImageUrl } from '../../../../lib/s3-images';

export const runtime = 'nodejs';
const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' };
export async function GET() {
  if (!adminDb) return NextResponse.json({ error: 'Character service is not configured.' }, { status: 503, headers });
  const snapshot = await adminDb.collection('characters').where('status', '==', 'Published').get();
  const characters = await Promise.all(snapshot.docs.map(async doc => {
    const data = doc.data(); const imageKey = characterImageKey(data.imageKey, data.image);
    return { id: doc.id, name: data.name, title: data.title ?? '', bio: data.bio ?? data.description ?? '', tags: Array.isArray(data.tags) ? data.tags : [], imageUrl: await signedCharacterImageUrl(imageKey) };
  }));
  return NextResponse.json({ characters: characters.sort((a, b) => String(a.name).localeCompare(String(b.name))) }, { headers });
}
