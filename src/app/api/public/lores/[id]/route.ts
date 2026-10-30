import { NextResponse } from 'next/server';
import { isDevContentSnapshot } from '../../../../../lib/dev-content-db';
import { devContentRead } from '../../../../../lib/dev-content-read';
import { adminDb } from '../../../../../lib/firebase-admin';
import { signedCharacterImageUrl } from '../../../../../lib/s3-images';
import { playerFromRequest } from '../../../../../lib/player-auth';
import { playerDisplayProfiles } from '../../../../../lib/player-profiles';

export const runtime = 'nodejs';
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'private, no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isDevContentSnapshot()) return devContentRead('lore', request, (await params).id);
  if (!adminDb) return NextResponse.json({ error: 'Lore service is not configured.' }, { status: 503, headers });
  const { id } = await params;
  const loreRef = adminDb.collection('lores').doc(id);
  const data = (await loreRef.get()).data();
  if (!data || data.status !== 'Published') return NextResponse.json({ error: 'Lore not found.' }, { status: 404, headers });

  const player = await playerFromRequest(request);
  const userVote = player
    ? (await loreRef.collection('votes').doc(player.id).get()).data()?.value ?? 0
    : 0;
  const keys = Array.isArray(data.imageKeys) ? data.imageKeys.filter((key): key is string => typeof key === 'string') : [];
  const uploaderId = data.source === 'revamp' && typeof data.uploaderId === 'string' ? data.uploaderId : null;
  const uploader = uploaderId ? await playerDisplayProfiles([uploaderId], new Map()).then(profiles => profiles.get(uploaderId)) : undefined;

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
    uploaderId: uploader ? uploaderId : null,
    uploaderName: uploader?.username ?? null,
  }, { headers });
}
