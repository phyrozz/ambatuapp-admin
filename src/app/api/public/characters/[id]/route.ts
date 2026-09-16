import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../lib/firebase-admin';
import { characterImageKey, signedCharacterImageUrl } from '../../../../../lib/s3-images';

export const runtime = 'nodejs';
const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' };
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!adminDb) return NextResponse.json({ error: 'Character service is not configured.' }, { status: 503, headers });
  const { id } = await params; const snapshot = await adminDb.collection('characters').doc(id).get(); const data = snapshot.data();
  if (!data || data.status !== 'Published') return NextResponse.json({ error: 'Character not found.' }, { status: 404, headers });
  const imageKey = characterImageKey(data.imageKey, data.image);
  return NextResponse.json({ id: snapshot.id, name: data.name, title: data.title ?? '', bio: data.bio ?? data.description ?? '', tags: Array.isArray(data.tags) ? data.tags : [], imageUrl: await signedCharacterImageUrl(imageKey) }, { headers });
}
