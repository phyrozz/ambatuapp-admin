import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withDreamDb } from "./dev-content-db";
import { dreamBody, dreamCursor, DreamError } from "./dream-validation";
import {
  attachmentDto,
  cleanupJob,
  eligibleDream,
  stageContent,
} from "../../dream-media/core.mjs";
import {
  requireMedia,
  tryDreamCleanup,
  tryOwnerDreamCleanup,
} from "./dream-storage";

type DreamRow = {
  id: string;
  author_id: string;
  body: string;
  audience: "public" | "friends" | "only_me";
  publication: string;
  revision: number;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
  username: string | null;
  cursor_time?: string;
  attachment_ids: string[];
  buss_up_count: number;
  buss_down_count: number;
  pending_edit: {
    text: string;
    audience: string;
    attachmentIds: string[];
  } | null;
};
const selection = `SELECT d.*,p.username FROM app.dreams d LEFT JOIN app.player_profiles p ON p.id=d.author_id`;
async function present(
  db: PoolClient,
  rows: DreamRow[],
  viewer: string | null,
) {
  const idsFor = (row: DreamRow) =>
    row.author_id === viewer && row.pending_edit
      ? row.pending_edit.attachmentIds
      : row.attachment_ids;
  const ids = rows.flatMap(idsFor);
  const attachments = ids.length
    ? (
        await db.query(
          "SELECT * FROM app.dream_attachments WHERE id=ANY($1::uuid[])",
          [ids],
        )
      ).rows
    : [];
  const byId = new Map(attachments.map((row) => [row.id, row]));
  const votes = viewer && rows.length
    ? (await db.query("SELECT dream_id,value FROM app.dream_votes WHERE voter_id=$1 AND dream_id=ANY($2::uuid[])", [viewer, rows.map((row) => row.id)])).rows
    : [];
  const viewerVotes = new Map(votes.map((vote) => [vote.dream_id, vote.value]));
  return rows.map((row) => {
    const pending = row.author_id === viewer ? row.pending_edit : null;
    const media = idsFor(row)
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map(attachmentDto);
    return {
      id: row.id,
      authorId: row.author_id,
      authorName: row.username,
      text: pending?.text ?? row.body,
      audience: pending?.audience ?? row.audience,
      publication: pending
        ? media.some((a) => a.state === "failed")
          ? "failed"
          : "processing"
        : row.publication,
      ...(pending
        ? { hasPublishedVersion: row.publication === "published" }
        : {}),
      revision: row.revision,
      attachments: media,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      publishedAt: row.published_at?.toISOString() ?? null,
      votes: { up: row.buss_up_count, down: row.buss_down_count, viewerVote: viewerVotes.get(row.id) ?? 0 },
    };
  });
}
async function read(db: PoolClient, id: string, viewer: string | null) {
  const row = (
    await db.query<DreamRow>(
      `${selection} WHERE d.id=$1 AND ${eligibleDream}`,
      [id, viewer],
    )
  ).rows[0];
  if (!row) throw new DreamError("DREAM_UNAVAILABLE", 404);
  return (await present(db, [row], viewer))[0];
}
async function lockAuthor(db: PoolClient, author: string) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `dream-author:${author}`,
  ]);
  if (
    (
      await db.query("SELECT 1 FROM app.player_deletions WHERE player_id=$1", [
        author,
      ])
    ).rowCount
  )
    throw new DreamError("ACCOUNT_UNAVAILABLE", 403);
}
export function getDream(id: string, viewer: string | null) {
  return withDreamDb((db) => read(db, id, viewer));
}
export async function createDream(author: string, value: unknown, key: string) {
  const body = dreamBody(value),
    text = body.text ?? "",
    audience = body.audience ?? "public",
    publication = body.publish === false ? "draft" : "published";
  if (body.attachmentIds?.length) requireMedia();
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        text,
        audience,
        publication,
        ...(body.attachmentIds?.length
          ? { attachmentIds: body.attachmentIds }
          : {}),
      }),
    )
    .digest("hex");
  return withDreamDb(async (db) => {
    await lockAuthor(db, author);
    const prior = (
      await db.query<{ request_hash: string | null; dream_id: string | null }>(
        "SELECT request_hash,dream_id FROM app.dream_requests WHERE author_id=$1 AND request_key=$2",
        [author, key],
      )
    ).rows[0];
    if (prior) {
      if (!prior.dream_id) throw new DreamError("DREAM_UNAVAILABLE", 410);
      if (prior.request_hash !== hash)
        throw new DreamError("IDEMPOTENCY_CONFLICT", 409);
      return read(db, prior.dream_id, author);
    }
    const id = randomUUID();
    const initial = (
      await db.query<DreamRow>(
        "INSERT INTO app.dreams (id,author_id,body,audience,publication,attachment_ids) VALUES ($1,$2,$3,$4,'draft',$5) RETURNING *",
        [id, author, text, audience, body.attachmentIds ?? []],
      )
    ).rows[0];
    const invalid = await stageContent(db, initial, {
      ...body,
      publish: publication === "published",
    });
    if (invalid) throw new DreamError(invalid, 422);
    await db.query(
      "INSERT INTO app.dream_requests (author_id,request_key,request_hash,dream_id) VALUES ($1,$2,$3,$4)",
      [author, key, hash, id],
    );
    return read(db, id, author);
  });
}
export async function editDream(id: string, author: string, value: unknown) {
  const body = dreamBody(value, true);
  const saved = await withDreamDb(async (db) => {
    await lockAuthor(db, author);
    const current = (
      await db.query<DreamRow>(
        "SELECT * FROM app.dreams WHERE id=$1 AND author_id=$2 FOR UPDATE",
        [id, author],
      )
    ).rows[0];
    if (!current) throw new DreamError("DREAM_UNAVAILABLE", 404);
    if (current.revision !== body.revision)
      throw new DreamError("REVISION_CONFLICT", 409);
    const existing = new Set([
      ...current.attachment_ids,
      ...(current.pending_edit?.attachmentIds ?? []),
    ]);
    if (body.attachmentIds?.some((attachment) => !existing.has(attachment)))
      requireMedia();
    const invalid = await stageContent(db, current, body);
    if (invalid) throw new DreamError(invalid, 422);
    await db.query("UPDATE app.dreams SET revision=revision+1 WHERE id=$1", [
      id,
    ]);
    return read(db, id, author);
  });
  await tryOwnerDreamCleanup(author);
  return saved;
}
export async function deleteDream(id: string, author: string) {
  const operation = await withDreamDb(async (db) => {
    await lockAuthor(db, author);
    const row = (
      await db.query(
        "SELECT id FROM app.dreams WHERE id=$1 AND author_id=$2 FOR UPDATE",
        [id, author],
      )
    ).rows[0];
    if (!row) throw new DreamError("DREAM_UNAVAILABLE", 404);
    const attachments = (
      await db.query(
        "SELECT * FROM app.dream_attachments WHERE dream_id=$1 FOR UPDATE",
        [id],
      )
    ).rows;
    const job = await cleanupJob(db, author, attachments, "all", id);
    await db.query(
      "UPDATE app.dream_requests SET dream_id=NULL,request_hash=NULL WHERE dream_id=$1 AND author_id=$2",
      [id, author],
    );
    await db.query("DELETE FROM app.dreams WHERE id=$1 AND author_id=$2", [
      id,
      author,
    ]);
    return job;
  });
  await tryDreamCleanup([operation]);
  return operation
    ? { operationId: operation, state: "pending" as const }
    : null;
}
export async function myDreams(author: string, raw: string | null) {
  const cursor = dreamCursor(raw, author);
  return withDreamDb(async (db) => {
    if (
      (
        await db.query(
          "SELECT 1 FROM app.player_deletions WHERE player_id=$1",
          [author],
        )
      ).rowCount
    )
      throw new DreamError("ACCOUNT_UNAVAILABLE", 403);
    const result = await db.query<DreamRow>(
      `SELECT d.*,p.username,to_char(d.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
      FROM app.dreams d LEFT JOIN app.player_profiles p ON p.id=d.author_id WHERE d.author_id=$1
      AND ($2::timestamptz IS NULL OR (d.created_at,d.id)<($2::timestamptz,$3::uuid)) ORDER BY d.created_at DESC,d.id DESC LIMIT 13`,
      [author, cursor?.time ?? null, cursor?.id ?? null],
    );
    const page = result.rows.slice(0, 12),
      last = page.at(-1);
    return {
      dreams: await present(db, page, author),
      nextCursor:
        result.rows.length > 12 && last
          ? Buffer.from(
              JSON.stringify({
                v: 1,
                owner: author,
                time: last.cursor_time,
                id: last.id,
              }),
            ).toString("base64url")
          : null,
    };
  });
}
/** Server-only integration hook. Full account deletion is delivered in phase 7. */
export async function beginPlayerDreamDeletion(author: string) {
  const jobs = await withDreamDb(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `dream-author:${author}`,
    ]);
    await db.query(
      "INSERT INTO app.player_deletions (player_id,state) VALUES ($1,'pending') ON CONFLICT (player_id) DO NOTHING",
      [author],
    );
    // Lock all affected parents in one order before counter triggers/cascades run.
    await db.query("SELECT id FROM app.dreams WHERE author_id=$1 OR id IN (SELECT dream_id FROM app.dream_votes WHERE voter_id=$1) ORDER BY id FOR UPDATE", [author]);
    await db.query("DELETE FROM app.dream_votes WHERE voter_id=$1", [author]);
    await db.query("DELETE FROM app.dream_vote_requests WHERE voter_id=$1", [author]);
    await db.query("DELETE FROM app.dream_vote_budgets WHERE voter_id=$1", [author]);
    const attachments = (
      await db.query(
        "SELECT * FROM app.dream_attachments WHERE owner_id=$1 FOR UPDATE",
        [author],
      )
    ).rows;
    const operations = [];
    for (let start = 0; start < attachments.length; start += 25)
      operations.push(
        await cleanupJob(db, author, attachments.slice(start, start + 25)),
      );
    await db.query("DELETE FROM app.dream_attachments WHERE owner_id=$1", [
      author,
    ]);
    await db.query("DELETE FROM app.dream_media_sessions WHERE viewer_id=$1", [
      author,
    ]);
    await db.query("DELETE FROM app.dream_upload_budgets WHERE owner_id=$1", [
      author,
    ]);
    await db.query("DELETE FROM app.dream_requests WHERE author_id=$1", [
      author,
    ]);
    await db.query("DELETE FROM app.dreams WHERE author_id=$1", [author]);
    return (
      await db.query(
        "SELECT id FROM app.dream_media_jobs WHERE owner_id=$1 AND state='pending' ORDER BY created_at",
        [author],
      )
    ).rows.map((row) => row.id as string);
  });
  await tryDreamCleanup(jobs);
  return jobs;
}
