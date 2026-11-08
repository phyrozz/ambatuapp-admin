import { createHash, randomBytes, randomUUID } from "node:crypto";
import { withDreamDb } from "./dev-content-db";
import { DreamError, validDreamId } from "./dream-validation";
import {
  requireMedia,
  signDreamUpload,
  tryDreamCleanup,
} from "./dream-storage";
import {
  attachmentDto,
  cleanupJob,
  eligibleDream,
} from "../../dream-media/core.mjs";

async function lock(db: import("pg").PoolClient, owner: string) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `dream-author:${owner}`,
  ]);
  if (
    (
      await db.query("SELECT 1 FROM app.player_deletions WHERE player_id=$1", [
        owner,
      ])
    ).rowCount
  )
    throw new DreamError("ACCOUNT_UNAVAILABLE", 403);
}
export async function reserveDreamUpload(owner: string, value: unknown) {
  const { namespace } = requireMedia();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DreamError("INVALID_ATTACHMENT", 422);
  const body = value as Record<string, unknown>;
  const extensions: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "video/mp4": "mp4",
  };
  const type = String(body.contentType),
    kind = type === "video/mp4" ? "video" : "image";
  if (
    Object.keys(body).some(
      (k) => !["kind", "contentType", "bytes"].includes(k),
    ) ||
    body.kind !== kind ||
    !extensions[type] ||
    !Number.isSafeInteger(body.bytes) ||
    Number(body.bytes) < 1 ||
    Number(body.bytes) > (kind === "video" ? 200 : 10) * 1024 * 1024
  )
    throw new DreamError("INVALID_ATTACHMENT", 422);
  const id = randomUUID(),
    segment = createHash("sha256").update(owner).digest("hex").slice(0, 32);
  const inputKey = `${namespace}/input/${segment}/${id}/${randomUUID()}/source.${extensions[type]}`;
  await withDreamDb(async (db) => {
    await lock(db, owner);
    await db.query(
      `INSERT INTO app.dream_upload_budgets(owner_id) VALUES($1) ON CONFLICT(owner_id) DO UPDATE
      SET requests=CASE WHEN dream_upload_budgets.window_started<now()-interval '1 day' THEN 0 ELSE dream_upload_budgets.requests END,
      bytes=CASE WHEN dream_upload_budgets.window_started<now()-interval '1 day' THEN 0 ELSE dream_upload_budgets.bytes END,
      window_started=CASE WHEN dream_upload_budgets.window_started<now()-interval '1 day' THEN now() ELSE dream_upload_budgets.window_started END`,
      [owner],
    );
    const quota = (
      await db.query(
        `SELECT requests,bytes,(SELECT count(*) FROM app.dream_attachments WHERE owner_id=$1
      AND (dream_id IS NULL OR state IN ('awaiting_upload','processing')))::int AS pending FROM app.dream_upload_budgets WHERE owner_id=$1 FOR UPDATE`,
        [owner],
      )
    ).rows[0];
    if (
      quota.pending >= 50 ||
      quota.requests >= 200 ||
      Number(quota.bytes) + Number(body.bytes) > 2 * 1024 ** 3
    )
      throw new DreamError("UPLOAD_QUOTA", 429);
    const globalQuota = await db.query(
      "SELECT app.dream_media_upload($1) AS allowed",
      [body.bytes],
    );
    if (!globalQuota.rows[0]?.allowed)
      throw new DreamError("UPLOAD_QUOTA", 429);
    await db.query(
      "UPDATE app.dream_upload_budgets SET requests=requests+1,bytes=bytes+$2 WHERE owner_id=$1",
      [owner, body.bytes],
    );
    await db.query(
      `INSERT INTO app.dream_attachments(id,owner_id,kind,content_type,declared_bytes,input_key,upload_expires_at)
      VALUES($1,$2,$3,$4,$5,$6,now()+interval '5 minutes')`,
      [id, owner, kind, type, body.bytes, inputKey],
    );
  });
  return {
    id,
    kind,
    state: "awaiting_upload",
    ...(await signDreamUpload(inputKey, type, Number(body.bytes))),
  };
}
export function dreamUpload(owner: string, id: string) {
  if (!validDreamId(id)) throw new DreamError("DREAM_UNAVAILABLE", 404);
  return withDreamDb(async (db) => {
    await lock(db, owner);
    const row = (
      await db.query(
        "SELECT * FROM app.dream_attachments WHERE id=$1 AND owner_id=$2",
        [id, owner],
      )
    ).rows[0];
    if (!row) throw new DreamError("DREAM_UNAVAILABLE", 404);
    return attachmentDto(row);
  });
}
export async function changeDreamUpload(
  owner: string,
  id: string,
  retry: boolean,
) {
  if (!validDreamId(id)) throw new DreamError("DREAM_UNAVAILABLE", 404);
  const job = await withDreamDb(async (db) => {
    await lock(db, owner);
    const row = (
      await db.query(
        "SELECT * FROM app.dream_attachments WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [id, owner],
      )
    ).rows[0];
    if (!row || (!retry && row.dream_id))
      throw new DreamError("DREAM_UNAVAILABLE", 404);
    if (retry) {
      requireMedia();
      if (
        row.state !== "failed" ||
        row.error_code !== "PROCESSING_FAILED" ||
        row.attempts >= 3
      )
        throw new DreamError("ATTACHMENT_RESELECT", 409);
      await db.query(
        "UPDATE app.dream_attachments SET state='awaiting_upload',error_code=NULL,updated_at=now() WHERE id=$1",
        [id],
      );
      return null;
    }
    const operation = await cleanupJob(db, owner, [row]);
    await db.query("DELETE FROM app.dream_attachments WHERE id=$1", [id]);
    return operation;
  });
  await tryDreamCleanup([job]);
}
const hashGrant = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function createDreamMediaSession(
  id: string,
  viewer: string | null,
  value: unknown,
) {
  requireMedia();
  if (
    !validDreamId(id) ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => k !== "token")
  )
    throw new DreamError("INVALID_DREAM", 422);
  const supplied = (value as { token?: unknown }).token;
  if (
    supplied !== undefined &&
    (typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied))
  )
    throw new DreamError("INVALID_DREAM", 422);
  return withDreamDb(async (db) => {
    const dream = (
      await db.query(
        `SELECT d.* FROM app.dreams d WHERE d.id=$1 AND ${eligibleDream}`,
        [id, viewer],
      )
    ).rows[0];
    if (!dream) throw new DreamError("DREAM_UNAVAILABLE", 404);
    const ids =
      dream.author_id === viewer && dream.pending_edit
        ? dream.pending_edit.attachmentIds
        : dream.attachment_ids;
    const available = (
      await db.query(
        "SELECT id,kind FROM app.dream_attachments WHERE dream_id=$1 AND id=ANY($2::uuid[]) AND state='ready'",
        [id, ids],
      )
    ).rows;
    const token =
      typeof supplied === "string" ? supplied : randomBytes(32).toString("hex");
    if (supplied) {
      const prior = (
        await db.query(
          "SELECT * FROM app.dream_media_sessions WHERE token_hash=$1 AND dream_id=$2 AND viewer_id IS NOT DISTINCT FROM $3 AND expires_at>now()",
          [hashGrant(token), id, viewer],
        )
      ).rows[0];
      if (!prior) throw new DreamError("DREAM_UNAVAILABLE", 404);
      await db.query(
        "UPDATE app.dream_media_sessions SET expires_at=now()+interval '5 minutes',attachment_ids=$2 WHERE token_hash=$1",
        [hashGrant(token), available.map((a) => a.id)],
      );
    } else
      await db.query(
        "INSERT INTO app.dream_media_sessions VALUES($1,$2,$3,$4,now()+interval '5 minutes')",
        [hashGrant(token), viewer, id, available.map((a) => a.id)],
      );
    const base = process.env.AMBATUPOST_MEDIA_BASE_URL!.replace(/\/$/, "");
    const parsed = new URL(base);
    if (
      parsed.protocol !== "https:" &&
      !(
        process.env.NODE_ENV === "development" &&
        ["localhost", "127.0.0.1"].includes(parsed.hostname)
      )
    )
      throw new DreamError("MEDIA_UNAVAILABLE", 503);
    return {
      token,
      expiresIn: 300,
      media: available.map((a) => ({
        id: a.id,
        url: `${base}/media/${a.id}?grant=${token}`,
        thumbnail: `${base}/media/${a.id}?grant=${token}&thumbnail=1`,
      })),
    };
  });
}
export function dreamOperation(owner: string, id: string) {
  if (!validDreamId(id)) throw new DreamError("DREAM_UNAVAILABLE", 404);
  return withDreamDb(async (db) => {
    const row = (
      await db.query(
        "SELECT id,state,error_code FROM app.dream_media_jobs WHERE id=$1 AND owner_id=$2",
        [id, owner],
      )
    ).rows[0];
    if (!row) throw new DreamError("DREAM_UNAVAILABLE", 404);
    return { operationId: row.id, state: row.state, error: row.error_code };
  });
}
