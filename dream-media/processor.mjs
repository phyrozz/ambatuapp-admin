import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { cleanupJob, reconcileDream } from "./core.mjs";
import { transformMedia, InvalidMedia } from "./transform.mjs";
import { sweepCleanup } from "./cleanup.mjs";

export function processor({
  transaction,
  s3,
  bucket,
  namespace,
  transform = transformMedia,
  stopSignal,
}) {
  const inputPattern = new RegExp(
    `^${namespace}/input/[a-f0-9]{32}/[a-f0-9-]{36}/[a-f0-9-]{36}/source\\.(jpg|png|mp4)$`,
  );
  const lock = async (db, owner) =>
    db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `dream-author:${owner}`,
    ]);
  return async function processInput(key) {
    stopSignal?.throwIfAborted();
    if (!inputPattern.test(key)) return;
    const row = await transaction(
      async (db) =>
        (
          await db.query(
            "SELECT * FROM app.dream_attachments WHERE input_key=$1",
            [key],
          )
        ).rows[0],
    );
    if (!row || row.state === "ready") {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return;
    }
    if (
      row.state === "failed" ||
      row.state === "cancelled" ||
      (row.state === "processing" && new Date(row.lease_until) > new Date())
    )
      return;
    let head;
    try {
      head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    } catch (error) {
      if (
        error.name === "NotFound" ||
        error.$metadata?.httpStatusCode === 404
      ) {
        await transaction(async (db) => {
          await lock(db, row.owner_id);
          const expired =
            row.state === "processing" ||
            new Date(row.upload_expires_at).getTime() + 600_000 < Date.now();
          const changed = (
            await db.query(
              "UPDATE app.dream_attachments SET input_received=false,updated_at=now(),state=CASE WHEN $2 THEN 'failed' ELSE state END,error_code=CASE WHEN $2 THEN 'UPLOAD_EXPIRED' ELSE error_code END WHERE id=$1 AND (state='awaiting_upload' OR (state='processing' AND lease_until<now())) RETURNING *",
              [row.id, expired],
            )
          ).rows[0];
          if (expired && changed) {
            await cleanupJob(db, row.owner_id, [changed]);
            if (changed.dream_id) await reconcileDream(db, changed.dream_id);
          }
        });
        return;
      }
      throw error;
    }
    const generation = randomUUID();
    const claimed = await transaction(async (db) => {
      await lock(db, row.owner_id);
      const current = (
        await db.query(
          "SELECT * FROM app.dream_attachments WHERE id=$1 FOR UPDATE",
          [row.id],
        )
      ).rows[0];
      if (
        !current ||
        ["ready", "failed", "cancelled"].includes(current.state) ||
        (current.state === "processing" &&
          new Date(current.lease_until) > new Date()) ||
        (
          await db.query(
            "SELECT 1 FROM app.player_deletions WHERE player_id=$1",
            [row.owner_id],
          )
        ).rowCount
      )
        return null;
      if (current.output_prefix)
        await cleanupJob(db, row.owner_id, [current], "output");
      const prefix = `${namespace}/media/${row.input_key.split("/")[3]}/${row.id}/${generation}/`;
      return (
        await db.query(
          "UPDATE app.dream_attachments SET state='processing',generation=$2,output_prefix=$3,lease_until=now()+interval '3 minutes',attempts=attempts+1,updated_at=now() WHERE id=$1 RETURNING *",
          [row.id, generation, prefix],
        )
      ).rows[0];
    });
    if (!claimed) return;
    const directory = await mkdtemp(join(tmpdir(), "dream-media-"));
    const cancelled = new AbortController();
    const stop = () => cancelled.abort();
    stopSignal?.addEventListener("abort", stop, { once: true });
    if (stopSignal?.aborted) cancelled.abort();
    let finishing = false;
    const heartbeat = setInterval(() => {
      if (finishing) return;
      void transaction((db) =>
        db.query(
          "UPDATE app.dream_attachments SET lease_until=now()+interval '3 minutes' WHERE id=$1 AND generation=$2 AND state='processing'",
          [row.id, generation],
        ),
      )
        .then((result) => {
          if (!result.rowCount) cancelled.abort();
        })
        .catch(() => cancelled.abort());
    }, 30_000);
    try {
      if (Number(head.ContentLength) !== Number(row.declared_bytes))
        throw new InvalidMedia();
      const object = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key, IfMatch: head.ETag }),
        { abortSignal: cancelled.signal },
      );
      let total = 0;
      const bounded = new Transform({
        transform(chunk, encoding, callback) {
          total += chunk.length;
          callback(
            total > Number(row.declared_bytes) ? new InvalidMedia() : null,
            chunk,
          );
        },
      });
      const source = join(directory, "input");
      await pipeline(object.Body, bounded, createWriteStream(source), {
        signal: cancelled.signal,
      });
      if (total !== Number(row.declared_bytes)) throw new InvalidMedia();
      const output = await transform(
        source,
        directory,
        claimed,
        cancelled.signal,
      );
      if (
        output.bytes > (row.kind === "image" ? 10 : 200) * 1024 ** 2 ||
        (await stat(output.thumbnail)).size > 1024 ** 2
      )
        throw new InvalidMedia();
      // Output writes and the ready transition share the author lock. A delete
      // commits either before these writes (and prevents them), or after them
      // with all keys in its durable cleanup manifest. Never write after unlock.
      finishing = true;
      await transaction(async (db) => {
        await lock(db, row.owner_id);
        const live = (
          await db.query(
            "SELECT * FROM app.dream_attachments WHERE id=$1 AND generation=$2 AND state='processing' FOR UPDATE",
            [row.id, generation],
          )
        ).rows[0];
        if (
          !live ||
          (
            await db.query(
              "SELECT 1 FROM app.player_deletions WHERE player_id=$1",
              [row.owner_id],
            )
          ).rowCount
        )
          return;
        for (const [file, name, type] of [
          [
            output.file,
            row.kind === "image" ? "media.jpg" : "media.mp4",
            row.kind === "image" ? "image/jpeg" : "video/mp4",
          ],
          [output.thumbnail, "thumbnail.jpg", "image/jpeg"],
        ]) {
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: `${live.output_prefix}${name}`,
              Body: createReadStream(file),
              ContentLength: (await stat(file)).size,
              ContentType: type,
              CacheControl: "private, no-store",
            }),
            {
              abortSignal: AbortSignal.any([
                cancelled.signal,
                AbortSignal.timeout(90_000),
              ]),
            },
          );
        }
        await db.query(
          "UPDATE app.dream_attachments SET state='ready',output_bytes=$3,width=$4,height=$5,duration=$6,error_code=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND generation=$2",
          [
            row.id,
            generation,
            output.bytes,
            output.width,
            output.height,
            output.duration,
          ],
        );
        await cleanupJob(db, row.owner_id, [live], "input");
        if (live.dream_id) await reconcileDream(db, live.dream_id);
      });
    } catch (error) {
      await transaction(async (db) => {
        await lock(db, row.owner_id);
        const failed = (
          await db.query(
            "UPDATE app.dream_attachments SET state='failed',lease_until=NULL,error_code=$3,updated_at=now() WHERE id=$1 AND generation=$2 AND state='processing' RETURNING *",
            [
              row.id,
              generation,
              error instanceof InvalidMedia ? error.code : "PROCESSING_FAILED",
            ],
          )
        ).rows[0];
        // Covers a dropped SQL connection while S3 accepted an output write.
        // The known generation stays in a cleanup manifest even if its row was deleted.
        await cleanupJob(db, row.owner_id, [failed ?? claimed], "output");
        if (error instanceof InvalidMedia)
          await cleanupJob(db, row.owner_id, [failed ?? claimed], "input");
        if (failed?.dream_id) await reconcileDream(db, failed.dream_id);
      });
    } finally {
      clearInterval(heartbeat);
      stopSignal?.removeEventListener("abort", stop);
      await rm(directory, { recursive: true, force: true });
    }
    // Publication/replacement/failure cleanup is attempted immediately. The
    // independent maintenance loop handles outages and the final expiry sweep.
    const jobs = await transaction(
      async (db) =>
        (
          await db.query(
            "SELECT id FROM app.dream_media_jobs WHERE owner_id=$1 AND state='pending' AND last_swept_at IS NULL ORDER BY created_at LIMIT 10",
            [row.owner_id],
          )
        ).rows,
    );
    for (const job of jobs) {
      try {
        await transaction((db) =>
          sweepCleanup(db, s3, bucket, namespace, job.id),
        );
      } catch {
        /* Durable maintenance will retry. */
      }
    }
  };
}

export { noteObject } from "./objects.mjs";
