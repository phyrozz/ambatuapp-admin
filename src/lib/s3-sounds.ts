import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const SOUND_AUDIO_LIMIT = 20 * 1024 * 1024;

const audioTypes: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/webm": "webm",
  "audio/aac": "aac",
};

function soundBucket() {
  return process.env.AWS_S3_CHARACTER_IMAGES_BUCKET;
}

function soundRegion() {
  return (
    process.env.NEXT_PUBLIC_AWS_REGION ||
    process.env.AWS_REGION ||
    "ap-southeast-1"
  );
}

function soundClient() {
  return new S3Client({ region: soundRegion() });
}

export function soundExtension(contentType: string) {
  return audioTypes[contentType.toLowerCase().split(";")[0].trim()];
}

export function validSoundAssetKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^soundboard\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.(?:mp3|wav|ogg|m4a|webm|aac)$/.test(
      value,
    )
  );
}

export function adminSoundUploadKey(value: unknown, owner = "admin") {
  if (
    typeof value !== "string" ||
    !value.startsWith(`soundboard/${owner}/`) ||
    !/^soundboard\/[A-Za-z0-9_-]+\/[a-f0-9-]{36}\.(?:mp3|wav|ogg|m4a|webm|aac)$/.test(
      value,
    )
  ) {
    throw new Error("Upload an audio clip first.");
  }
  return value;
}

export async function createSoundUpload(
  fileName: unknown,
  contentType: unknown,
  size: unknown,
  owner = "admin",
) {
  const bucket = soundBucket();
  if (!bucket) throw new Error("Sound storage is not configured.");
  if (
    typeof fileName !== "string" ||
    !fileName.trim() ||
    fileName.length > 180 ||
    typeof contentType !== "string"
  ) {
    throw new Error("Choose a supported audio file.");
  }
  const extension = soundExtension(contentType);
  if (!extension)
    throw new Error("Use an MP3, WAV, OGG, M4A, AAC, or WebM audio file.");
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > SOUND_AUDIO_LIMIT
  ) {
    throw new Error("Audio clips must be 20 MB or smaller.");
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(owner))
    throw new Error("Could not prepare the audio upload.");
  const soundKey = `soundboard/${owner}/${crypto.randomUUID()}.${extension}`;
  const content = contentType.toLowerCase().split(";")[0].trim();
  const uploadUrl = await getSignedUrl(
    soundClient(),
    new PutObjectCommand({
      Bucket: bucket,
      Key: soundKey,
      ContentType: content,
      ContentLength: size,
    }),
    { expiresIn: 300 },
  );
  return { soundKey, uploadUrl, uploadHeaders: { "content-type": content } };
}

export async function verifySoundUpload(soundKey: string) {
  const bucket = soundBucket();
  if (!bucket) throw new Error("Sound storage is not configured.");
  const head = await soundClient().send(
    new HeadObjectCommand({ Bucket: bucket, Key: soundKey }),
  );
  const expectedExtension = soundKey.split(".").at(-1);
  if (
    !head.ContentLength ||
    head.ContentLength > SOUND_AUDIO_LIMIT ||
    soundExtension(head.ContentType ?? "") !== expectedExtension
  ) {
    throw new Error("The uploaded audio file is invalid or too large.");
  }
}

export async function signedSoundUrl(soundKey: string) {
  const bucket = soundBucket();
  if (!bucket) throw new Error("Sound storage is not configured.");
  return getSignedUrl(
    soundClient(),
    new GetObjectCommand({ Bucket: bucket, Key: soundKey }),
    { expiresIn: 3600 },
  );
}

export async function deleteSoundUpload(soundKey: string) {
  const bucket = soundBucket();
  if (!bucket) throw new Error("Sound storage is not configured.");
  await soundClient().send(
    new DeleteObjectCommand({ Bucket: bucket, Key: soundKey }),
  );
}
