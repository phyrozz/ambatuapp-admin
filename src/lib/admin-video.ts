import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { signedVideoUrl, videoBucket, videoClient } from './s3-videos';

export type VideoStatus = 'Draft' | 'Published';

export function videoFields(body: Record<string, unknown>) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const status = body.status;
  if (!title || title.length > 120) throw new Error('Enter a title up to 120 characters.');
  if (description.length > 1000) throw new Error('Description must be 1,000 characters or fewer.');
  if (status !== 'Draft' && status !== 'Published') throw new Error('Choose Draft or Published.');
  return { title, description, status: status as VideoStatus };
}

export function adminUploadKeys(body: Record<string, unknown>) {
  const videoKey = body.videoKey;
  const thumbnailKey = body.thumbnailKey;
  if (typeof videoKey !== 'string' || !/^videos\/admin\/[a-f0-9-]+\.mp4$/.test(videoKey)) throw new Error('Upload a video first.');
  if (typeof thumbnailKey !== 'string' || !/^video-thumbnails\/admin\/[a-f0-9-]+\.jpg$/.test(thumbnailKey)) throw new Error('Upload a thumbnail first.');
  if (videoKey.split('/').at(-1)?.split('.')[0] !== thumbnailKey.split('/').at(-1)?.split('.')[0]) throw new Error('Video and thumbnail do not match.');
  return { videoKey, thumbnailKey };
}

export async function hydrateVideo(id: string, data: Record<string, unknown>) {
  return {
    id,
    title: data.title ?? '',
    description: data.description ?? '',
    status: data.status ?? 'Draft',
    uploaderEmail: data.uploaderEmail ?? 'Unknown',
    upvotes: data.upvotes ?? 0,
    downvotes: data.downvotes ?? 0,
    commentCount: data.commentCount ?? 0,
    createdAt: (data.createdAt as { toDate?: () => Date } | undefined)?.toDate?.().toISOString() ?? null,
    videoUrl: typeof data.videoKey === 'string' ? await signedVideoUrl(data.videoKey) : '',
    thumbnailUrl: typeof data.thumbnailKey === 'string' ? await signedVideoUrl(data.thumbnailKey) : '',
  };
}

export async function deleteVideoAssets(data: Record<string, unknown>) {
  const bucket = videoBucket();
  if (!bucket) throw new Error('Video storage is not configured.');
  const keys = [data.videoKey, data.thumbnailKey].filter((key): key is string =>
    typeof key === 'string' && (key.startsWith('videos/') || key.startsWith('video-thumbnails/')),
  );
  const client = videoClient();
  await Promise.all(keys.map(Key => client.send(new DeleteObjectCommand({ Bucket: bucket, Key }))));
}
