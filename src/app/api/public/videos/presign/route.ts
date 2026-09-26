import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NextResponse } from 'next/server';
import { requirePlayer } from '../../../../../lib/player-auth';
import { videoBucket, videoClient } from '../../../../../lib/s3-videos';
import { VIDEO_UPLOAD_LIMIT } from '../../../../../lib/video-transcoding.mjs';

const allowed = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const extensions: Record<string, string> = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function POST(request: Request) {
  try {
    const player = await requirePlayer(request);
    const { fileName, contentType, fileSize } = await request.json();
    const bucket = videoBucket();
    if (!bucket) return NextResponse.json({ error: 'Video storage is not configured.' }, { status: 503, headers });
    if (typeof fileName !== 'string' || fileName.length > 180 || !allowed.has(contentType)) throw new Error('Use an MP4, WebM, or MOV video.');
    if (!Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > VIDEO_UPLOAD_LIMIT) throw new Error('Videos must be 200 MB or smaller.');
    const extension = extensions[contentType];
    const uploadId = crypto.randomUUID();
    const sourceKey = `video-upload-staging/${player.id}/${uploadId}.${extension}`;
    const videoKey = `videos/${player.id}/${uploadId}.mp4`;
    const thumbnailKey = `video-thumbnails/${player.id}/${uploadId}.jpg`;
    const [sourceUploadUrl, thumbnailUploadUrl] = await Promise.all([
      getSignedUrl(videoClient(), new PutObjectCommand({ Bucket: bucket, Key: sourceKey, ContentType: contentType }), { expiresIn: 300 }),
      getSignedUrl(videoClient(), new PutObjectCommand({ Bucket: bucket, Key: thumbnailKey, ContentType: 'image/jpeg' }), { expiresIn: 300 }),
    ]);
    return NextResponse.json({ sourceUploadUrl, sourceKey, videoKey, sourceUploadHeaders: { 'content-type': contentType }, thumbnailUploadUrl, thumbnailKey, thumbnailUploadHeaders: { 'content-type': 'image/jpeg' } }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not prepare upload.' }, { status: 401, headers });
  }
}
