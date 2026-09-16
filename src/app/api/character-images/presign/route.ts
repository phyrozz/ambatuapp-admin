import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/api-auth';

export const runtime = 'nodejs';
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const bucket = process.env.AWS_S3_CHARACTER_IMAGES_BUCKET;
    const region = process.env.NEXT_PUBLIC_AWS_REGION;
    if (!bucket || !region) return NextResponse.json({ error: 'S3 is not configured.' }, { status: 503 });
    const { fileName, contentType, characterId, scope = 'characters' } = await request.json();
    if (!fileName || !characterId || !['characters', 'lores'].includes(scope) || !allowedTypes.has(contentType)) return NextResponse.json({ error: 'A JPG, PNG, or WEBP image is required.' }, { status: 400 });
    const extension = contentType === 'image/jpeg' ? 'jpg' : contentType.split('/')[1];
    const key = `${scope}/${characterId}/${scope === 'characters' ? 'portrait' : 'image'}-${crypto.randomUUID()}.${extension}`;
    const client = new S3Client({ region });
    const uploadUrl = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: 300 });
    return NextResponse.json({ uploadUrl, key });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not create upload URL.' }, { status: 401 });
  }
}
