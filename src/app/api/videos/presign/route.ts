import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/api-auth';
import { videoBucket, videoClient } from '../../../../lib/s3-videos';
import { VIDEO_UPLOAD_LIMIT } from '../../../../lib/video-transcoding.mjs';

export const runtime = 'nodejs';
const extensions: Record<string, string> = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const bucket = videoBucket();
    if (!bucket) return NextResponse.json({ error: 'Video storage is not configured.' }, { status: 503 });
    const { fileName, contentType, fileSize } = await request.json();
    if (typeof fileName !== 'string' || !fileName || fileName.length > 180 || typeof contentType !== 'string' || !extensions[contentType]) throw new Error('Use an MP4, WebM, or MOV video.');
    if (!Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > VIDEO_UPLOAD_LIMIT) throw new Error('Videos must be 200 MB or smaller.');
    const uploadId = crypto.randomUUID();
    const sourceKey = `video-upload-staging/admin/${uploadId}.${extensions[contentType]}`;
    const videoKey = `videos/admin/${uploadId}.mp4`;
    const thumbnailKey = `video-thumbnails/admin/${uploadId}.jpg`;
    const client = videoClient();
    const [sourceUploadUrl, thumbnailUploadUrl] = await Promise.all([
      getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: sourceKey, ContentType: contentType }), { expiresIn: 300 }),
      getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: thumbnailKey, ContentType: 'image/jpeg' }), { expiresIn: 300 }),
    ]);
    return NextResponse.json({ sourceKey, videoKey, thumbnailKey, sourceUploadUrl, thumbnailUploadUrl, sourceUploadHeaders: { 'content-type': contentType }, thumbnailUploadHeaders: { 'content-type': 'image/jpeg' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not prepare upload.' }, { status: 400 });
  }
}
