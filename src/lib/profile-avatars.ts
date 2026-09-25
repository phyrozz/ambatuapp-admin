import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { videoBucket, videoClient, signedVideoUrl } from './s3-videos';

export const PROFILE_AVATAR_LIMIT = 3 * 1024 * 1024;

export function avatarImageType(type: string) {
  return type === 'image/jpeg' || type === 'image/jpg' ? 'jpg' : type === 'image/png' ? 'png' : null;
}

export function readJpegDimensions(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: (bytes[offset + 3] << 8) | bytes[offset + 4], width: (bytes[offset + 5] << 8) | bytes[offset + 6] };
    }
    offset += length;
  }
  return null;
}

export async function uploadProfileAvatar(key: string, bytes: Uint8Array, contentType: string, cacheControl = 'public, max-age=31536000, immutable') {
  const bucket = videoBucket();
  if (!bucket) throw new Error('Profile image storage is not configured.');
  await videoClient().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType, CacheControl: cacheControl }));
}

export async function profileAvatarUrl(key?: string) {
  if (!key) return null;
  return await signedVideoUrl(key) || null;
}

export function newProfileAvatarKey(prefix: string, extension: string) {
  return `profile-avatars/${prefix}/${randomUUID()}.${extension}`;
}

export async function bestEffortDeleteProfileAvatar(key?: string) {
  if (!key) return;
  try {
    const bucket = videoBucket();
    if (bucket) await videoClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch { /* An unreferenced object can be cleaned up later. */ }
}
