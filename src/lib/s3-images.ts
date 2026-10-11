import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export async function signedCharacterImageUrl(key?: string) {
  const bucket = process.env.AWS_S3_CHARACTER_IMAGES_BUCKET;
  const region = process.env.NEXT_PUBLIC_AWS_REGION;
  if (!key || !bucket || !region) return undefined;
  return getSignedUrl(
    new S3Client({ region }),
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 3600 },
  );
}

export function characterImageKey(imageKey?: string, legacyImage?: string) {
  if (imageKey?.startsWith("characters/")) return imageKey;
  if (!legacyImage) return undefined;
  if (legacyImage.startsWith("characters/")) return legacyImage;
  try {
    const key = decodeURIComponent(
      new URL(legacyImage).pathname.replace(/^\//, ""),
    );
    return key.startsWith("characters/") ? key : undefined;
  } catch {
    return undefined;
  }
}

export async function deleteCharacterImage(key?: string) {
  const bucket = process.env.AWS_S3_CHARACTER_IMAGES_BUCKET;
  const region = process.env.NEXT_PUBLIC_AWS_REGION;
  if (!key || !bucket || !region) return;
  await new S3Client({ region }).send(
    new DeleteObjectCommand({ Bucket: bucket, Key: key }),
  );
}

const loreImageTypes: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
export const PLAYER_LORE_IMAGE_LIMIT = 3 * 1024 * 1024;

function loreImageStorage() {
  const bucket = process.env.AWS_S3_CHARACTER_IMAGES_BUCKET;
  const region = process.env.NEXT_PUBLIC_AWS_REGION;
  if (!bucket || !region)
    throw new Error("Lore image storage is not configured.");
  return { bucket, client: new S3Client({ region }) };
}

export async function createPlayerLoreImageUpload(
  playerId: string,
  submissionId: string,
  contentType: unknown,
  size: unknown,
) {
  const imageType = typeof contentType === "string" ? contentType : "";
  const imageSize = typeof size === "number" ? size : 0;
  const extension = loreImageTypes[imageType];
  if (
    !extension ||
    !Number.isSafeInteger(imageSize) ||
    imageSize < 1 ||
    imageSize > PLAYER_LORE_IMAGE_LIMIT
  )
    throw new Error("Invalid lore image.");
  if (
    !/^[a-f0-9-]{36}$/i.test(playerId) ||
    !/^[a-f0-9-]{36}$/i.test(submissionId)
  )
    throw new Error("Invalid lore image destination.");
  const { bucket, client } = loreImageStorage();
  const key = `lores/player_${playerId}/${submissionId}/${crypto.randomUUID()}.${extension}`;
  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: imageType,
      ContentLength: imageSize,
    }),
    { expiresIn: 300 },
  );
  return { key, uploadUrl, uploadHeaders: { "content-type": imageType } };
}

export function isPlayerLoreImageKey(value: unknown, playerId: string) {
  return (
    typeof value === "string" &&
    new RegExp(
      `^lores/player_${playerId}/[a-f0-9-]{36}/[a-f0-9-]{36}\\.(?:jpg|png|webp)$`,
      "i",
    ).test(value)
  );
}

export async function verifyPlayerLoreImage(key: string) {
  const { bucket, client } = loreImageStorage();
  const head = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key }),
  );
  const extension = key.split(".").at(-1);
  if (
    !head.ContentLength ||
    head.ContentLength > PLAYER_LORE_IMAGE_LIMIT ||
    !head.ContentType ||
    loreImageTypes[head.ContentType.split(";")[0].trim().toLowerCase()] !==
      extension
  )
    throw new Error("Invalid lore image.");
}

export async function createPlayerCharacterImageUpload(
  playerId: string,
  submissionId: string,
  contentType: unknown,
  size: unknown,
) {
  const imageType = typeof contentType === "string" ? contentType : "";
  const imageSize = typeof size === "number" ? size : 0;
  const extension = loreImageTypes[imageType];
  if (
    !extension ||
    !Number.isSafeInteger(imageSize) ||
    imageSize < 1 ||
    imageSize > PLAYER_LORE_IMAGE_LIMIT
  )
    throw new Error("Invalid character image.");
  if (
    !/^[a-f0-9-]{36}$/i.test(playerId) ||
    !/^[a-f0-9-]{36}$/i.test(submissionId)
  )
    throw new Error("Invalid character image destination.");
  const { bucket, client } = loreImageStorage();
  const key = `characters/player_${playerId}/${submissionId}/${crypto.randomUUID()}.${extension}`;
  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: imageType,
      ContentLength: imageSize,
    }),
    { expiresIn: 300 },
  );
  return { key, uploadUrl, uploadHeaders: { "content-type": imageType } };
}

export function isPlayerCharacterImageKey(value: unknown, playerId: string) {
  return (
    typeof value === "string" &&
    new RegExp(
      `^characters/player_${playerId}/[a-f0-9-]{36}/[a-f0-9-]{36}\\.(?:jpg|png|webp)$`,
      "i",
    ).test(value)
  );
}

export async function verifyPlayerCharacterImage(key: string) {
  const { bucket, client } = loreImageStorage();
  const head = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key }),
  );
  const extension = key.split(".").at(-1);
  if (
    !head.ContentLength ||
    head.ContentLength > PLAYER_LORE_IMAGE_LIMIT ||
    !head.ContentType ||
    loreImageTypes[head.ContentType.split(";")[0].trim().toLowerCase()] !==
      extension
  )
    throw new Error("Invalid character image.");
}
