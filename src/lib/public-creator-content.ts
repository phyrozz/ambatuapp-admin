import { FieldPath } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";
import {
  isDevLeaderboardWriter,
  isDevLoreWriter,
  withDevLeaderboardDb,
  withDevLoreDb,
} from "./dev-content-db";
import { playerFromRequest } from "./player-auth";
import { validFriendId } from "./friend-list";
import { hiddenPlayerIds } from "./player-blocks";

export async function publicCreatorViewer(request: Request, id: string) {
  if (!validFriendId(id) || id === "admin")
    throw Object.assign(new Error("NOT_FOUND"), { status: 404 });
  let viewer;
  try {
    viewer = await playerFromRequest(request);
    if (request.headers.has("authorization") && !viewer) throw new Error();
  } catch {
    throw Object.assign(new Error("UNAUTHORIZED"), { status: 401 });
  }
  if ((await hiddenPlayerIds(viewer?.id, [id])).has(id))
    throw Object.assign(new Error("NOT_FOUND"), { status: 404 });
  return viewer?.id ?? null;
}
const games = ["ambatutap", "ambatusnake", "ambatublou", "flappy-bus"];
export async function creatorScores(id: string) {
  if (isDevLeaderboardWriter())
    return withDevLeaderboardDb(async (db) => {
      const rows = (
        await db.query(
          "SELECT game_id,score FROM app.leaderboard_entries WHERE game_id=ANY($1::text[]) AND player_id=$2",
          [games, id],
        )
      ).rows;
      return rows
        .map((row) => ({ gameId: row.game_id, score: Number(row.score) }))
        .filter((row) => Number.isSafeInteger(row.score) && row.score >= 0);
    });
  if (!adminDb) throw new Error("UNAVAILABLE");
  const entries = await Promise.all(
    games.map((game) =>
      adminDb!
        .collection("leaderboards")
        .doc(game)
        .collection("entries")
        .doc(id)
        .get(),
    ),
  );
  return entries.flatMap((entry, i) => {
    const score = entry.data()?.score;
    return entry.exists && Number.isSafeInteger(score) && score >= 0
      ? [{ gameId: games[i], score }]
      : [];
  });
}
export async function creatorPublishedLores(id: string, raw: string | null) {
  let cursor: { owner: string; id: string; time?: string } | null = null;
  if (raw) {
    try {
      if (raw.length > 1024) throw new Error();
      cursor = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
      if (
        !cursor ||
        cursor.owner !== id ||
        !validFriendId(cursor.id) ||
        (cursor.time !== undefined &&
          (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(cursor.time) ||
            !Number.isFinite(Date.parse(cursor.time))))
      )
        throw new Error();
    } catch {
      throw Object.assign(new Error("INVALID_CURSOR"), { status: 400 });
    }
  }
  if (isDevLoreWriter())
    return withDevLoreDb(async (db) => {
      if (cursor && !cursor.time)
        throw Object.assign(new Error("INVALID_CURSOR"), { status: 400 });
      const rows = (
        await db.query(
          `SELECT c.id,c.created_at,l.title,left(l.body,200) AS excerpt,
      to_char(coalesce(c.created_at,timestamptz '1970-01-01 00:00:00+00') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
      FROM app.content c JOIN app.lores l ON l.id=c.id AND l.kind=c.kind
      WHERE c.kind='lore' AND c.uploader_id=$1 AND c.source='revamp' AND c.status='Published'
      AND ($2::timestamptz IS NULL OR (coalesce(c.created_at,timestamptz '1970-01-01 00:00:00+00'),c.id COLLATE "C")<($2::timestamptz,$3 COLLATE "C"))
      ORDER BY coalesce(c.created_at,timestamptz '1970-01-01 00:00:00+00') DESC,c.id COLLATE "C" DESC LIMIT 13`,
          [id, cursor?.time ?? null, cursor?.id ?? null],
        )
      ).rows;
      const page = rows.slice(0, 12),
        last = page.at(-1);
      return {
        lores: page.map((row) => ({
          id: row.id,
          title: row.title ?? "",
          excerpt: row.excerpt ?? "",
          createdAt: row.created_at?.toISOString() ?? null,
        })),
        nextCursor:
          rows.length > 12 && last
            ? Buffer.from(
                JSON.stringify({
                  owner: id,
                  id: last.id,
                  time: last.cursor_time,
                }),
              ).toString("base64url")
            : null,
      };
    });
  if (!adminDb) throw new Error("UNAVAILABLE");
  if (cursor?.time)
    throw Object.assign(new Error("INVALID_CURSOR"), { status: 400 });
  let query = adminDb
    .collection("lores")
    .where("uploaderId", "==", id)
    .orderBy(FieldPath.documentId())
    .limit(41);
  if (cursor) query = query.startAfter(cursor.id);
  const snap = await query.get(),
    page = snap.docs.slice(0, 40),
    last = page.at(-1);
  return {
    lores: page
      .filter(
        (doc) =>
          doc.data().status === "Published" && doc.data().source === "revamp",
      )
      .map((doc) => ({
        id: doc.id,
        title: typeof doc.data().title === "string" ? doc.data().title : "",
        excerpt:
          typeof doc.data().text === "string"
            ? doc.data().text.slice(0, 200)
            : "",
        createdAt: doc.data().createdAt?.toDate?.().toISOString() ?? null,
      })),
    nextCursor:
      snap.size > 40 && last
        ? Buffer.from(JSON.stringify({ owner: id, id: last.id })).toString(
            "base64url",
          )
        : null,
  };
}
