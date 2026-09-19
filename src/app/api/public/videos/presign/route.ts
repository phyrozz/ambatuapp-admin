import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NextResponse } from 'next/server';
import { requirePlayer } from '../../../../../lib/player-auth';
import { videoBucket, videoClient } from '../../../../../lib/s3-videos';

const allowed = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function POST(request: Request) {
  try {
    const player = await requirePlayer(request);
    const { fileName, contentType } = await request.json();
    const bucket = videoBucket();
    if (!bucket) return NextResponse.json({ error: 'Video storage is not configured.' }, { status: 503, headers });
    if (typeof fileName !== 'string' || fileName.length > 180 || !allowed.has(contentType)) throw new Error('Use an MP4, WebM, or MOV video.');
    const extension = fileName.split('.').pop()?.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4';
    const uploadId = crypto.randomUUID();
    const key = `videos/${player.id}/${uploadId}.${extension}`;
    const thumbnailKey = `video-thumbnails/${player.id}/${uploadId}.jpg`;
    const [uploadUrl, thumbnailUploadUrl] = await Promise.all([
      getSignedUrl(videoClient(), new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: 300 }),
      getSignedUrl(videoClient(), new PutObjectCommand({ Bucket: bucket, Key: thumbnailKey, ContentType: 'image/jpeg' }), { expiresIn: 300 }),
    ]);
    return NextResponse.json({ uploadUrl, key, uploadHeaders: { 'content-type': contentType }, thumbnailUploadUrl, thumbnailKey, thumbnailUploadHeaders: { 'content-type': 'image/jpeg' } }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not prepare upload.' }, { status: 401, headers });
  }
}
