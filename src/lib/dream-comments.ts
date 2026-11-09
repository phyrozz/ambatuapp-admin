import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withDreamDb } from "./dev-content-db";
import {
  DreamError,
  dreamCursor,
  dreamVoteBody,
  validDreamId,
} from "./dream-validation";
import { eligibleDream } from "../../dream-media/core.mjs";
import { profileAvatarUrl } from "./profile-avatars";

type CommentRow = {
  id: string;
  dream_id: string;
  parent_id: string | null;
  author_id: string | null;
  body: string | null;
  revision: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  moderation: string;
  buss_up_count: number;
  buss_down_count: number;
  username?: string | null;
  avatar_key?: string | null;
  viewer_vote?: -1 | 0 | 1;
  cursor_time?: string;
  allowed?: boolean;
};

// $2 is always the verified viewer; never derive eligibility from client flags.
const visibleComment = `c.moderation='visible' AND (c.author_id IS NULL OR (
  NOT EXISTS(SELECT 1 FROM app.player_deletions WHERE player_id=c.author_id)
  AND NOT EXISTS(SELECT 1 FROM app.player_blocks WHERE
    (blocker_id=$2 AND blocked_id=c.author_id) OR (blocker_id=c.author_id AND blocked_id=$2))))`;
const selection = `SELECT c.*,p.username,p.avatar_key,COALESCE(v.value,0) AS viewer_vote,
  to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
  FROM app.dream_comments c LEFT JOIN app.player_profiles p ON p.id=c.author_id
  LEFT JOIN app.dream_comment_votes v ON v.comment_id=c.id AND v.voter_id=$2`;

export function commentBody(value: unknown, editing = false) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DreamError("INVALID_COMMENT", 422);
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).some(
      (key) =>
        !["text", ...(editing ? ["revision"] : ["parentId"])].includes(key),
    ) ||
    typeof body.text !== "string" ||
    !body.text.trim() ||
    Array.from(body.text).length > 2000 ||
    Array.from(body.text).some(
      (point) =>
        point === "\0" ||
        ((point.codePointAt(0) ?? 0) >= 0xd800 &&
          (point.codePointAt(0) ?? 0) <= 0xdfff),
    ) ||
    (editing &&
      (!Number.isSafeInteger(body.revision) ||
        (body.revision as number) < 1)) ||
    (!editing && body.parentId != null && !validDreamId(body.parentId))
  )
    throw new DreamError("INVALID_COMMENT", 422);
  return {
    text: body.text,
    parentId: (body.parentId ?? null) as string | null,
    revision: body.revision as number | undefined,
  };
}

async function requireDream(
  db: PoolClient,
  id: string,
  viewer: string | null,
  writing = false,
) {
  const result = await db.query(
    `SELECT d.id FROM app.dreams d WHERE d.id=$1 AND d.publication='published'
    AND d.moderation='visible' AND ${eligibleDream} ${writing ? "FOR UPDATE OF d" : "FOR SHARE OF d"}`,
    [id, viewer],
  );
  if (!result.rowCount) throw new DreamError("DREAM_UNAVAILABLE", 404);
}
async function actorLock(db: PoolClient, actor: string) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `dream-author:${actor}`,
  ]);
}
async function rowFor(
  db: PoolClient,
  dream: string,
  viewer: string | null,
  id: string,
) {
  const row = (
    await db.query<CommentRow>(
      `${selection} WHERE c.dream_id=$1 AND c.id=$3 AND ${visibleComment}`,
      [dream, viewer, id],
    )
  ).rows[0];
  if (!row) throw new DreamError("COMMENT_UNAVAILABLE", 404);
  if (row.parent_id) {
    const parent = await db.query(
      `SELECT c.id FROM app.dream_comments c WHERE c.dream_id=$1 AND c.id=$3 AND c.parent_id IS NULL AND ${visibleComment}`,
      [dream, viewer, row.parent_id],
    );
    if (!parent.rowCount) throw new DreamError("COMMENT_UNAVAILABLE", 404);
  }
  return row;
}
async function present(rows: CommentRow[]) {
  const avatars = new Map(
    await Promise.all(
      [
        ...new Set(
          rows
            .filter((row) => !row.deleted_at)
            .map((row) => row.avatar_key)
            .filter((key): key is string => Boolean(key)),
        ),
      ].map(
        async (key) =>
          [key, await profileAvatarUrl(key).catch(() => null)] as const,
      ),
    ),
  );
  return rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    authorId: row.deleted_at ? null : row.author_id,
    authorName: row.deleted_at ? null : (row.username ?? null),
    authorAvatarUrl:
      row.deleted_at || !row.avatar_key
        ? null
        : (avatars.get(row.avatar_key) ?? null),
    text: row.deleted_at ? null : row.body,
    deleted: Boolean(row.deleted_at),
    retained: Boolean(row.deleted_at),
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    votes: {
      up: row.deleted_at ? 0 : row.buss_up_count,
      down: row.deleted_at ? 0 : row.buss_down_count,
      viewerVote: row.deleted_at ? 0 : (row.viewer_vote ?? 0),
    },
  }));
}
async function budget(db: PoolClient, actor: string, kind: "write" | "vote") {
  const result = await db.query(
    `INSERT INTO app.dream_comment_budgets AS b(actor_id,kind) VALUES($1,$2)
    ON CONFLICT(actor_id,kind) DO UPDATE SET
      minute_started=CASE WHEN b.minute_started<=now()-interval '1 minute' THEN now() ELSE b.minute_started END,
      minute_requests=CASE WHEN b.minute_started<=now()-interval '1 minute' THEN 1 ELSE b.minute_requests+1 END,
      day_started=CASE WHEN b.day_started<=now()-interval '24 hours' THEN now() ELSE b.day_started END,
      day_requests=CASE WHEN b.day_started<=now()-interval '24 hours' THEN 1 ELSE b.day_requests+1 END
    WHERE (b.minute_started<=now()-interval '1 minute' OR b.minute_requests<$3)
      AND (b.day_started<=now()-interval '24 hours' OR b.day_requests<$4) RETURNING actor_id`,
    [actor, kind, kind === "write" ? 20 : 60, kind === "write" ? 200 : 1000],
  );
  if (!result.rowCount) throw new DreamError("COMMENT_RATE_LIMITED", 429);
}

export async function listDreamComments(
  dream: string,
  viewer: string | null,
  raw: string | null,
  parent: string | null,
) {
  if (parent !== null && !validDreamId(parent))
    throw new DreamError("COMMENT_UNAVAILABLE", 404);
  const scope = JSON.stringify(["comments-v1", dream, viewer, parent]);
  const cursor = dreamCursor(raw, scope);
  return withDreamDb(async (db) => {
    await requireDream(db, dream, viewer);
    if (parent && (await rowFor(db, dream, viewer, parent)).parent_id)
      throw new DreamError("COMMENT_UNAVAILABLE", 404);
    // Bound candidates before filtering blocked authors, including empty continuation batches.
    const rows = (
      await db.query<CommentRow>(
        `${selection}
      WHERE c.dream_id=$1 AND ${parent ? 'c.parent_id=$3::uuid' : 'c.parent_id IS NULL AND $3::uuid IS NULL'}
        AND ($4::timestamptz IS NULL OR (c.created_at,c.id)<($4::timestamptz,$5::uuid))
      ORDER BY c.created_at DESC,c.id DESC LIMIT 13`,
        [dream, viewer, parent, cursor?.time ?? null, cursor?.id ?? null],
      )
    ).rows;
    const page = rows.slice(0, 12),
      last = page.at(-1);
    const allowed = page.length
      ? (
          await db.query<{ id: string }>(
            `SELECT c.id FROM app.dream_comments c WHERE c.dream_id=$1 AND c.id=ANY($3::uuid[]) AND ${visibleComment} AND (c.parent_id IS NULL OR c.deleted_at IS NULL)`,
            [dream, viewer, page.map((row) => row.id)],
          )
        ).rows
      : [];
    const visible = new Set(allowed.map((row) => row.id));
    // Preserve PostgreSQL microsecond precision rather than JS Date's millisecond truncation.
    return {
      comments: await present(page.filter((row) => visible.has(row.id))),
      nextCursor:
        rows.length > 12 && last
          ? Buffer.from(
              JSON.stringify({
                v: 1,
                owner: scope,
                time: last.cursor_time,
                id: last.id,
              }),
            ).toString("base64url")
          : null,
    };
  });
}

export async function createDreamComment(
  dream: string,
  actor: string,
  value: unknown,
  key: string,
) {
  const body = commentBody(value);
  const hash = createHash("sha256")
    .update(JSON.stringify([body.text, body.parentId]))
    .digest("hex");
  return withDreamDb(async (db) => {
    await actorLock(db, actor);
    await requireDream(db, dream, actor, true);
    let parent: string | null = null;
    if (body.parentId) {
      const target = await rowFor(db, dream, actor, body.parentId);
      parent = target.parent_id ?? target.id;
    }
    const prior = (
      await db.query(
        "SELECT request_hash,comment_id FROM app.dream_comment_requests WHERE dream_id=$1 AND actor_id=$2 AND request_key=$3",
        [dream, actor, key],
      )
    ).rows[0];
    if (prior) {
      if (!prior.comment_id) throw new DreamError("COMMENT_UNAVAILABLE", 410);
      if (prior.request_hash !== hash)
        throw new DreamError("IDEMPOTENCY_CONFLICT", 409);
      return (
        await present([await rowFor(db, dream, actor, prior.comment_id)])
      )[0];
    }
    await budget(db, actor, "write");
    const id = randomUUID();
    await db.query(
      "INSERT INTO app.dream_comments(id,dream_id,parent_id,author_id,body) VALUES($1,$2,$3,$4,$5)",
      [id, dream, parent, actor, body.text],
    );
    await db.query(
      "INSERT INTO app.dream_comment_requests(dream_id,actor_id,request_key,request_hash,comment_id) VALUES($1,$2,$3,$4,$5)",
      [dream, actor, key, hash, id],
    );
    return (await present([await rowFor(db, dream, actor, id)]))[0];
  });
}
export async function editDreamComment(
  dream: string,
  id: string,
  actor: string,
  value: unknown,
) {
  const body = commentBody(value, true);
  return withDreamDb(async (db) => {
    await actorLock(db, actor);
    await requireDream(db, dream, actor, true);
    const current = await rowFor(db, dream, actor, id);
    if (current.author_id !== actor || current.deleted_at)
      throw new DreamError("COMMENT_UNAVAILABLE", 404);
    if (current.revision !== body.revision)
      throw new DreamError("COMMENT_REVISION_CONFLICT", 409);
    await budget(db, actor, "write");
    await db.query(
      "UPDATE app.dream_comments SET body=$2,revision=revision+1,updated_at=now() WHERE id=$1",
      [id, body.text],
    );
    return (await present([await rowFor(db, dream, actor, id)]))[0];
  });
}
export async function deleteDreamComment(
  dream: string,
  id: string,
  actor: string,
) {
  return withDreamDb(async (db) => {
    await actorLock(db, actor);
    await requireDream(db, dream, actor, true);
    const current = await rowFor(db, dream, actor, id);
    if (current.author_id !== actor || current.deleted_at)
      throw new DreamError("COMMENT_UNAVAILABLE", 404);
    await db.query("DELETE FROM app.dream_comment_votes WHERE comment_id=$1", [
      id,
    ]);
    await db.query(
      "DELETE FROM app.dream_comment_vote_requests WHERE comment_id=$1",
      [id],
    );
    await db.query(
      "UPDATE app.dream_comment_requests SET comment_id=NULL,request_hash=NULL WHERE comment_id=$1",
      [id],
    );
    const retained =
      !current.parent_id &&
      Boolean(
        (
          await db.query(
            "SELECT 1 FROM app.dream_comments WHERE dream_id=$2 AND parent_id=$1 LIMIT 1",
            [id, dream],
          )
        ).rowCount,
      );
    await db.query(
      "UPDATE app.dream_comments SET author_id=NULL,body=NULL,deleted_at=now(),updated_at=now(),revision=revision+1 WHERE id=$1",
      [id],
    );
    const result = (await present([await rowFor(db, dream, actor, id)]))[0];
    if (!retained)
      await db.query("DELETE FROM app.dream_comments WHERE id=$1", [id]);
    if (current.parent_id)
      await db.query(
        "DELETE FROM app.dream_comments c WHERE c.id=$1 AND c.deleted_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.dream_comments child WHERE child.dream_id=c.dream_id AND child.parent_id=c.id)",
        [current.parent_id],
      );
    return { ...result, retained };
  });
}
export async function voteDreamComment(
  dream: string,
  id: string,
  actor: string,
  body: unknown,
  key: string,
) {
  const value = dreamVoteBody(body);
  return withDreamDb(async (db) => {
    await actorLock(db, actor);
    await requireDream(db, dream, actor, true);
    const current = await rowFor(db, dream, actor, id);
    if (current.deleted_at) throw new DreamError("COMMENT_UNAVAILABLE", 404);
    const prior = (
      await db.query(
        "SELECT value FROM app.dream_comment_vote_requests WHERE comment_id=$1 AND voter_id=$2 AND request_key=$3",
        [id, actor, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.value !== value)
        throw new DreamError("IDEMPOTENCY_CONFLICT", 409);
    } else {
      await budget(db, actor, "vote");
      if (value === 0)
        await db.query(
          "DELETE FROM app.dream_comment_votes WHERE comment_id=$1 AND voter_id=$2",
          [id, actor],
        );
      else
        await db.query(
          `INSERT INTO app.dream_comment_votes(comment_id,voter_id,value) VALUES($1,$2,$3)
        ON CONFLICT(comment_id,voter_id) DO UPDATE SET value=EXCLUDED.value,updated_at=now()
        WHERE dream_comment_votes.value IS DISTINCT FROM EXCLUDED.value`,
          [id, actor, value],
        );
      await db.query(
        "INSERT INTO app.dream_comment_vote_requests(comment_id,voter_id,request_key,value) VALUES($1,$2,$3,$4)",
        [id, actor, key, value],
      );
    }
    return (await present([await rowFor(db, dream, actor, id)]))[0].votes;
  });
}

/** Caller holds the deleting player's advisory lock and affected Dream locks in ID order. */
export async function cleanupPlayerDreamComments(
  db: PoolClient,
  actor: string,
) {
  const authored = (
    await db.query<{ id: string; parent_id: string | null }>(
      "SELECT id,parent_id FROM app.dream_comments WHERE author_id=$1",
      [actor],
    )
  ).rows;
  await db.query(
    "DELETE FROM app.dream_comment_votes WHERE voter_id=$1 OR comment_id IN (SELECT id FROM app.dream_comments WHERE author_id=$1)",
    [actor],
  );
  await db.query(
    "DELETE FROM app.dream_comment_vote_requests WHERE voter_id=$1 OR comment_id IN (SELECT id FROM app.dream_comments WHERE author_id=$1)",
    [actor],
  );
  await db.query("DELETE FROM app.dream_comment_requests WHERE actor_id=$1", [
    actor,
  ]);
  await db.query("DELETE FROM app.dream_comment_budgets WHERE actor_id=$1", [
    actor,
  ]);
  await db.query(
    "UPDATE app.dream_comments SET author_id=NULL,body=NULL,deleted_at=now(),updated_at=now(),revision=revision+1 WHERE author_id=$1",
    [actor],
  );
  if (authored.length) {
    await db.query(
      "DELETE FROM app.dream_comments WHERE id=ANY($1::uuid[]) AND parent_id IS NOT NULL",
      [authored.map((row) => row.id)],
    );
    const roots = [...new Set(authored.map((row) => row.parent_id ?? row.id))];
    await db.query(
      "DELETE FROM app.dream_comments c WHERE c.id=ANY($1::uuid[]) AND c.deleted_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.dream_comments child WHERE child.dream_id=c.dream_id AND child.parent_id=c.id)",
      [roots],
    );
  }
}
