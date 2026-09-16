import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export async function signedCharacterImageUrl(key?: string) {
  const bucket = process.env.AWS_S3_CHARACTER_IMAGES_BUCKET;
  const region = process.env.NEXT_PUBLIC_AWS_REGION;
  if (!key || !bucket || !region) return undefined;
  return getSignedUrl(new S3Client({ region }), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 3600 });
}

export function characterImageKey(imageKey?: string, legacyImage?: string) {
  if (imageKey?.startsWith('characters/')) return imageKey;
  if (!legacyImage) return undefined;
  if (legacyImage.startsWith('characters/')) return legacyImage;
  try {
    const key = decodeURIComponent(new URL(legacyImage).pathname.replace(/^\//, ''));
    return key.startsWith('characters/') ? key : undefined;
  } catch { return undefined; }
}

export async function deleteCharacterImage(key?: string) {
  const bucket = process.env.AWS_S3_CHARACTER_IMAGES_BUCKET;
  const region = process.env.NEXT_PUBLIC_AWS_REGION;
  if (!key || !bucket || !region) return;
  await new S3Client({ region }).send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
