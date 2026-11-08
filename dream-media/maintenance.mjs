import { cleanupJob } from "./core.mjs";
import { sweepCleanup } from "./cleanup.mjs";
export async function maintain({ transaction, s3, bucket, namespace }) {
  // Expired uploads and abandoned draft replacements get the same durable cleanup.
  await transaction(async (db) => {
    const owner = (
      await db.query(
        "SELECT owner_id FROM app.dream_attachments WHERE dream_id IS NULL AND created_at<now()-interval '1 day' ORDER BY created_at LIMIT 1",
      )
    ).rows[0]?.owner_id;
    if (owner) {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `dream-author:${owner}`,
      ]);
      const rows = (
        await db.query(
          "SELECT * FROM app.dream_attachments WHERE owner_id=$1 AND dream_id IS NULL AND created_at<now()-interval '1 day' ORDER BY created_at LIMIT 25 FOR UPDATE",
          [owner],
        )
      ).rows;
      await cleanupJob(db, owner, rows);
      await db.query(
        "DELETE FROM app.dream_attachments WHERE id=ANY($1::uuid[])",
        [rows.map((r) => r.id)],
      );
    }
    await db.query(
      "DELETE FROM app.dream_media_sessions WHERE expires_at<now()",
    );
  });
  const jobs = await transaction(
    async (db) =>
      (
        await db.query(
          "SELECT id FROM app.dream_media_jobs WHERE state='pending' AND (last_swept_at IS NULL OR last_swept_at<now()-interval '30 seconds') ORDER BY last_swept_at NULLS FIRST LIMIT 10",
        )
      ).rows,
  );
  for (const job of jobs) {
    try {
      await transaction((db) =>
        sweepCleanup(db, s3, bucket, namespace, job.id),
      );
    } catch {
      await transaction((db) =>
        db.query(
          "UPDATE app.dream_media_jobs SET error_code='MEDIA_CLEANUP_FAILED',last_swept_at=now() WHERE id=$1",
          [job.id],
        ),
      );
      console.error("MEDIA_CLEANUP_FAILED", job.id);
    }
  }
}
