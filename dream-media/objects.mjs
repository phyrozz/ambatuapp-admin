import { DeleteObjectCommand } from "@aws-sdk/client-s3";

// Runs independently of decoding so late storage commits are removed even
// while the worker is busy, including after an earlier manifest completed.
export async function noteObject({ transaction, s3, bucket, namespace }, key) {
  const input = new RegExp(
    `^${namespace}/input/[a-f0-9]{32}/[a-f0-9-]{36}/[a-f0-9-]{36}/source\\.(jpg|png|mp4)$`,
  );
  const output = new RegExp(
    `^${namespace}/media/[a-f0-9]{32}/[a-f0-9-]{36}/[a-f0-9-]{36}/(media\\.(jpg|mp4)|thumbnail\\.jpg)$`,
  );
  if (input.test(key)) {
    const row = await transaction(
      async (db) =>
        (
          await db.query(
            `SELECT a.id,a.state,a.error_code FROM app.dream_attachments a WHERE input_key=$1
      AND NOT EXISTS(SELECT 1 FROM app.player_deletions WHERE player_id=a.owner_id)`,
            [key],
          )
        ).rows[0],
    );
    if (
      !row ||
      ["ready", "cancelled"].includes(row.state) ||
      (row.state === "failed" && row.error_code !== "PROCESSING_FAILED")
    )
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    else if (row.state === "awaiting_upload")
      await transaction((db) =>
        db.query(
          "UPDATE app.dream_attachments SET input_received=true WHERE id=$1",
          [row.id],
        ),
      );
  } else if (output.test(key)) {
    const prefix = key.slice(0, key.lastIndexOf("/") + 1);
    const live = await transaction(
      async (db) =>
        (
          await db.query(
            `SELECT 1 FROM app.dream_attachments a WHERE output_prefix=$1 AND state IN ('ready','processing')
      AND NOT EXISTS(SELECT 1 FROM app.player_deletions WHERE player_id=a.owner_id)`,
            [prefix],
          )
        ).rowCount,
    );
    if (!live)
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}

export function inputKeys(message, bucket) {
  const body = JSON.parse(message);
  return (body.Records ?? [])
    .filter(
      (e) =>
        e.eventSource === "aws:s3" &&
        e.eventName?.startsWith("ObjectCreated:") &&
        e.s3?.bucket?.name === bucket,
    )
    .map((e) => decodeURIComponent(e.s3.object.key.replace(/\+/g, " ")));
}
