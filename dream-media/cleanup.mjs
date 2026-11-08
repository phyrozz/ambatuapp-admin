import { DeleteObjectsCommand } from "@aws-sdk/client-s3";

export async function sweepCleanup(db, s3, bucket, namespace, id) {
  const job = (
    await db.query(
      "SELECT * FROM app.dream_media_jobs WHERE id=$1 AND state='pending' FOR UPDATE SKIP LOCKED",
      [id],
    )
  ).rows[0];
  if (!job) return;
  const keys = job.prefixes.flatMap((prefix) => {
    if (
      !prefix.startsWith(`${namespace}/`) ||
      !prefix.endsWith("/") ||
      prefix.includes("..")
    )
      throw new Error("INVALID_CLEANUP_PREFIX");
    const names = prefix.startsWith(`${namespace}/input/`)
      ? ["source.jpg", "source.png", "source.mp4"]
      : ["media.jpg", "media.mp4", "thumbnail.jpg"];
    return names.map((name) => ({ Key: `${prefix}${name}` }));
  });
  for (let start = 0; start < keys.length; start += 1000) {
    const result = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: keys.slice(start, start + 1000), Quiet: true },
      }),
      { abortSignal: AbortSignal.timeout(10_000) },
    );
    if (result.Errors?.length) throw new Error("MEDIA_CLEANUP_FAILED");
  }
  const dependencies = (
    await db.query(
      "SELECT 1 FROM app.dream_media_jobs WHERE id=ANY($1::uuid[]) AND state<>'complete' LIMIT 1",
      [job.depends_on],
    )
  ).rowCount;
  const complete =
    !dependencies && new Date(job.not_before).getTime() <= Date.now();
  await db.query(
    `UPDATE app.dream_media_jobs SET state=$2,error_code=NULL,last_swept_at=now(),
    prefixes=CASE WHEN $2='complete' THEN '{}'::text[] ELSE prefixes END,
    attachment_ids=CASE WHEN $2='complete' THEN '{}'::uuid[] ELSE attachment_ids END,
    dream_ids=CASE WHEN $2='complete' THEN '{}'::uuid[] ELSE dream_ids END,
    reserved_bytes=CASE WHEN $2='complete' THEN 0 ELSE reserved_bytes END,
    depends_on=CASE WHEN $2='complete' THEN '{}'::uuid[] ELSE depends_on END WHERE id=$1`,
    [id, complete ? "complete" : "pending"],
  );
}
