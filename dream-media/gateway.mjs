import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { database } from "./db.mjs";
import { eligibleDream } from "./core.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const mediaHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Access-Control-Allow-Headers": "range",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Expose-Headers":
    "Accept-Ranges, Content-Range, Content-Length",
  "Accept-Ranges": "bytes",
};
export function byteRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new Error("RANGE_INVALID");
  let start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  let end = match[1]
    ? match[2]
      ? Math.min(Number(match[2]), size - 1)
      : size - 1
    : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= size ||
    end < start
  )
    throw new Error("RANGE_INVALID");
  return { start, end };
}
export function mediaServer({
  query,
  s3,
  bucket,
  enabled = () => process.env.AMBATUPOST_ENABLED === "true",
  costGuard = false,
}) {
  let active = 0;
  return createServer(async (request, response) => {
    for (const [key, value] of Object.entries(mediaHeaders))
      response.setHeader(key, value);
    if (active >= 64) {
      response.writeHead(503, { "Retry-After": "1" });
      response.end();
      return;
    }
    active++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active--;
      }
    };
    response.once("close", release);
    response.once("finish", release);
    try {
      const url = new URL(request.url, "http://gateway.invalid");
      if (url.pathname === "/health") {
        response.writeHead(200);
        response.end("ok");
        return;
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      const id = url.pathname.split("/")[2],
        token = url.searchParams.get("grant");
      if (
        !enabled() ||
        !["GET", "HEAD"].includes(request.method) ||
        url.pathname !== `/media/${id}` ||
        !uuid.test(id ?? "") ||
        !/^[a-f0-9]{64}$/.test(token ?? "")
      )
        throw new Error("UNAVAILABLE");
      const grant = (
        await query(
          "SELECT * FROM app.dream_media_sessions WHERE token_hash=$1 AND expires_at>now()",
          [createHash("sha256").update(token).digest("hex")],
        )
      ).rows[0];
      if (!grant || !grant.attachment_ids.includes(id))
        throw new Error("UNAVAILABLE");
      const row = (
        await query(
          `SELECT a.* FROM app.dreams d JOIN app.dream_attachments a ON a.dream_id=d.id
        WHERE a.id=$1 AND a.state='ready' AND d.id=$3 AND ${eligibleDream}
        AND (a.id=ANY(d.attachment_ids) OR (d.author_id=$2 AND d.pending_edit->'attachmentIds' @> to_jsonb(a.id::text)))`,
          [id, grant.viewer_id, grant.dream_id],
        )
      ).rows[0];
      if (!row) throw new Error("UNAVAILABLE");
      const key = `${row.output_prefix}${url.searchParams.get("thumbnail") === "1" ? "thumbnail.jpg" : row.kind === "image" ? "media.jpg" : "media.mp4"}`;
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      const size = Number(head.ContentLength);
      if (!size) throw new Error("UNAVAILABLE");
      let range;
      try {
        range = byteRange(request.headers.range, size);
      } catch {
        response.writeHead(416, { "Content-Range": `bytes */${size}` });
        response.end();
        return;
      }
      const contentType =
        url.searchParams.get("thumbnail") === "1" || row.kind === "image"
          ? "image/jpeg"
          : "video/mp4";
      const headers = {
        "Content-Type": contentType,
        "Content-Length": range ? range.end - range.start + 1 : size,
        ...(range
          ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` }
          : {}),
      };
      if (request.method === "HEAD") {
        response.writeHead(range ? 206 : 200, headers);
        response.end();
        return;
      }
      if (
        costGuard &&
        !(
          await query("SELECT app.dream_media_delivery($1) AS allowed", [
            headers["Content-Length"],
          ])
        ).rows[0]?.allowed
      )
        throw new Error("MEDIA_BUDGET");
      const abort = new AbortController();
      response.on("close", () => abort.abort());
      const object = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
        { abortSignal: abort.signal },
      );
      response.writeHead(range ? 206 : 200, headers);
      // Stream with backpressure, including across the Lambda loopback adapter.
      await pipeline(object.Body, response, { signal: abort.signal });
    } catch (error) {
      if (response.headersSent) response.destroy();
      else {
        const unavailable = error?.message === "UNAVAILABLE";
        if (!unavailable) console.error("MEDIA_GATEWAY_UNAVAILABLE");
        response.writeHead(
          unavailable ? 404 : error?.message === "MEDIA_BUDGET" ? 429 : 503,
          {
            "Content-Type": "application/json",
          },
        );
        response.end(
          JSON.stringify({
            error: unavailable ? "DREAM_UNAVAILABLE" : "MEDIA_UNAVAILABLE",
          }),
        );
      }
    }
  });
}
async function serve() {
  const { pool, verify } = database("media_reader");
  await verify();
  if (!process.env.MEDIA_BUCKET)
    throw new Error("MEDIA_GATEWAY_CONFIG_MISSING");
  const server = mediaServer({
    query: (sql, args) => pool.query(sql, args),
    s3: new S3Client({}),
    bucket: process.env.MEDIA_BUCKET,
  });
  server.listen(Number(process.env.PORT || 8080), "0.0.0.0");
  process.on("SIGTERM", () =>
    server.close(() => {
      void pool.end();
    }),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await serve().catch(() => {
    console.error("MEDIA_GATEWAY_START_FAILED");
    process.exit(1);
  });
}
