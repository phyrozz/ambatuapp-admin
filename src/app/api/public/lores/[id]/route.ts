import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../lib/firebase-admin';
import { signedCharacterImageUrl } from '../../../../../lib/s3-images';

export const runtime = 'nodejs';
const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'private, no-store' };

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!adminDb) return NextResponse.json({ error: 'Lore service is not configured.' }, { status: 503, headers });
  const { id } = await params;
  const loreRef = adminDb.collection('lores').doc(id);
  const data = (await loreRef.get()).data();
  if (!data || data.status !== 'Published') return NextResponse.json({ error: 'Lore not found.' }, { status: 404, headers });

  const anonymousId = new URL(request.url).searchParams.get('anonymousId');
  const userVote = anonymousId && anonymousId.length >= 12
    ? (await loreRef.collection('votes').doc(anonymousId).get()).data()?.value ?? 0
    : 0;
  const keys = Array.isArray(data.imageKeys) ? data.imageKeys.filter((key): key is string => typeof key === 'string') : [];

  return NextResponse.json({
    id,
    title: data.title,
    text: data.text,
    translations: data.translations ?? [],
    tags: data.tags ?? [],
    imageUrls: await Promise.all(keys.map(signedCharacterImageUrl)),
    upvotes: data.upvotes ?? 0,
    downvotes: data.downvotes ?? 0,
    commentCount: data.commentCount ?? 0,
    userVote,
  }, { headers });
}
