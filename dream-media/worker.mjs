import { pathToFileURL } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { database } from "./db.mjs";
import { processor } from "./processor.mjs";
import { setTimeout as delay } from "node:timers/promises";
export { inputKeys } from "./objects.mjs";
export { maintain } from "./maintenance.mjs";

// RunTask only: no ECS service, idle queue polling or unbounded task lifetime.
export async function work() {
  const deadline = Date.parse(process.env.WORKER_DEADLINE ?? "");
  const lease = process.env.WORKER_LEASE_ID;
  if (
    !lease ||
    !Number.isFinite(deadline) ||
    deadline <= Date.now() ||
    deadline > Date.now() + 7200_000
  )
    throw new Error("MEDIA_WORKER_CONFIG_MISSING");
  const stop = new AbortController();
  const abort = () => stop.abort();
  process.once("SIGTERM", abort);
  const timer = setTimeout(abort, Math.max(1, deadline - Date.now() - 15_000));
  // Enforce termination even if a decoder/network/library stops responding.
  const hardStop = setTimeout(
    () => process.exit(1),
    Math.max(1, deadline - Date.now()),
  );
  const { pool, transaction, verify } = database("worker");
  try {
    await verify();
    const control = (
      await pool.query("SELECT lease_id FROM app.dream_worker_control")
    ).rows[0];
    if (control?.lease_id !== lease || !process.env.MEDIA_BUCKET)
      throw new Error("MEDIA_WORKER_LEASE_INVALID");
    const processInput = processor({
      transaction,
      s3: new S3Client({ maxAttempts: 2 }),
      bucket: process.env.MEDIA_BUCKET,
      namespace: `ambatupost/${process.env.STAGE}`,
      stopSignal: stop.signal,
    });
    let idleSince;
    while (!stop.signal.aborted) {
      const next = (
        await pool.query(
          "SELECT input_key FROM app.dream_attachments WHERE (state='awaiting_upload' AND input_received) OR (state='processing' AND lease_until<now()) ORDER BY updated_at LIMIT 1",
        )
      ).rows[0];
      if (!next) {
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= 10_000) break;
        await delay(1000, undefined, { signal: stop.signal }).catch(() => {});
        continue;
      }
      idleSince = undefined;
      await processInput(next.input_key);
    }
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGTERM", abort);
    await pool.end();
    clearTimeout(hardStop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await work().catch(() => {
    console.error("MEDIA_WORKER_START_FAILED");
    process.exit(1);
  });
