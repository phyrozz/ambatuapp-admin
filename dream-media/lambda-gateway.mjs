import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { S3Client } from "@aws-sdk/client-s3";
import { mediaServer } from "./gateway.mjs";
import { runtime } from "./runtime-config.mjs";
let local;
export async function gatewayOrigin() {
  if (!local)
    local = (async () => {
      const { pool } = await runtime("media_reader");
      const server = mediaServer({
        query: (sql, args) => pool.query(sql, args),
        s3: new S3Client({ maxAttempts: 1 }),
        bucket: process.env.MEDIA_BUCKET,
        costGuard: true,
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    })().catch((error) => {
      local = null;
      throw error;
    });
  return local;
}
async function budgetQuery(sql, args) {
  return (await runtime("media_reader")).pool.query(sql, args);
}
const headers = {
  "content-type": "application/json",
  "cache-control": "private, no-store",
  "access-control-allow-origin": "*",
};
export function streamingGateway({
  origin = gatewayOrigin,
  query = budgetQuery,
  metadata = (stream, data) =>
    globalThis.awslambda.HttpResponseStream.from(stream, data),
  http = fetch,
} = {}) {
  return async (event, stream, context) => {
    if (context) context.callbackWaitsForEmptyEventLoop = false;
    let lease,
      started = false;
    try {
      lease = (await query("SELECT app.dream_media_begin() AS lease")).rows[0]
        ?.lease;
      if (!lease) {
        metadata(stream, { statusCode: 429, headers }).end(
          '{"error":"MEDIA_UNAVAILABLE"}',
        );
        return;
      }
      const url = new URL(await origin());
      url.pathname = event.rawPath || "/";
      url.search = event.rawQueryString || "";
      const abort = AbortSignal.timeout(170_000);
      const result = await http(url, {
        method: event.requestContext?.http?.method || "GET",
        headers: event.headers?.range ? { range: event.headers.range } : {},
        redirect: "manual",
        signal: abort,
      });
      const responseHeaders = Object.fromEntries(
        [...result.headers].filter(
          ([key]) =>
            !["connection", "keep-alive", "transfer-encoding", "date"].includes(
              key,
            ),
        ),
      );
      const output = metadata(stream, {
        statusCode: result.status,
        headers: responseHeaders,
      });
      started = true;
      if (result.body)
        await pipeline(Readable.fromWeb(result.body), output, {
          signal: abort,
        });
      else output.end();
    } catch {
      if (!stream.writableFinished && !stream.destroyed) {
        if (started) stream.destroy();
        else
          metadata(stream, { statusCode: 503, headers }).end(
            '{"error":"MEDIA_UNAVAILABLE"}',
          );
      }
    } finally {
      if (lease)
        await query("SELECT app.dream_media_finish($1)", [lease]).catch(
          () => {},
        );
    }
  };
}
export const handler =
  globalThis.awslambda?.streamifyResponse?.(streamingGateway());
