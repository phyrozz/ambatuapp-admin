import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { sweepCleanup } from "../../dream-media/cleanup.mjs";
import { withDreamDb, isProductionPostgres } from "./dev-content-db";
import { DreamError } from "./dream-validation";

export function dreamStorage() {
  const bucket = process.env.AWS_S3_CHARACTER_IMAGES_BUCKET;
  if (!bucket) throw new DreamError("MEDIA_UNAVAILABLE", 503);
  return {
    bucket,
    namespace: `ambatupost/${isProductionPostgres() ? "prod" : "dev"}`,
    // Upload signing has no body to checksum. A default empty-body CRC would
    // reject every non-empty browser upload; content length remains signed.
    s3: new S3Client({
      region:
        process.env.NEXT_PUBLIC_AWS_REGION ||
        process.env.AWS_REGION ||
        "ap-southeast-1",
      requestChecksumCalculation: "WHEN_REQUIRED",
    }),
  };
}
export function mediaEnabled() {
  return process.env.AMBATUPOST_MEDIA_ENABLED === "true";
}
export function requireMedia() {
  if (!mediaEnabled() || !process.env.AMBATUPOST_MEDIA_BASE_URL)
    throw new DreamError("MEDIA_UNAVAILABLE", 503);
  try {
    const url = new URL(process.env.AMBATUPOST_MEDIA_BASE_URL);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname && url.pathname !== "/") ||
      (url.protocol !== "https:" &&
        !(
          process.env.NODE_ENV === "development" &&
          ["localhost", "127.0.0.1"].includes(url.hostname)
        ))
    )
      throw new Error("INVALID_GATEWAY");
  } catch {
    throw new DreamError("MEDIA_UNAVAILABLE", 503);
  }
  return dreamStorage();
}
export async function signDreamUpload(
  key: string,
  contentType: string,
  bytes: number,
) {
  const { s3, bucket } = requireMedia();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
    ContentLength: bytes,
    IfNoneMatch: "*",
  });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
  return {
    uploadUrl,
    uploadHeaders: { "content-type": contentType, "if-none-match": "*" },
  };
}
// Cleanup ignores the feature flag. API deletion attempts it immediately; the
// durable worker continues retrying and sweeps again after upload grants expire.
export async function tryDreamCleanup(ids: (string | null)[]) {
  const jobs = ids.filter((id): id is string => Boolean(id));
  if (!jobs.length) return;
  try {
    const { s3, bucket, namespace } = dreamStorage();
    for (const id of jobs) {
      try {
        await withDreamDb((db) => sweepCleanup(db, s3, bucket, namespace, id));
      } catch {
        await withDreamDb((db) =>
          db.query(
            "UPDATE app.dream_media_jobs SET error_code='MEDIA_CLEANUP_FAILED',last_swept_at=now() WHERE id=$1 AND state='pending'",
            [id],
          ),
        );
      }
    }
  } catch {
    /* The committed cleanup jobs remain pending for the worker. */
  }
}
export async function tryOwnerDreamCleanup(owner: string) {
  try {
    const jobs = await withDreamDb(
      async (db) =>
        (
          await db.query(
            "SELECT id FROM app.dream_media_jobs WHERE owner_id=$1 AND state='pending' AND last_swept_at IS NULL ORDER BY created_at LIMIT 4",
            [owner],
          )
        ).rows,
    );
    await tryDreamCleanup(jobs.map((row) => row.id));
  } catch {
    /* A committed edit remains successful while durable cleanup retries. */
  }
}
