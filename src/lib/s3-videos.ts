import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const videoBucket = () => process.env.AWS_S3_CHARACTER_IMAGES_BUCKET;
export const videoRegion = () => process.env.NEXT_PUBLIC_AWS_REGION || process.env.AWS_REGION || 'ap-southeast-1';

export function videoClient() { return new S3Client({ region: videoRegion() }); }

export async function signedVideoUrl(key: string) {
  const bucket = videoBucket();
  if (!bucket || !key) return '';
  return getSignedUrl(videoClient(), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 3600 });
}
