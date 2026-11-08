import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { PoolClient } from "pg";
import { withDreamDb } from "./dev-content-db";
import { DreamError, validDreamId } from "./dream-validation";
import { presentDreams, type DreamRow } from "./dreams";
import { eligibleDream } from "../../dream-media/core.mjs";
import {
  DREAM_BATCH,
  DREAM_WINDOW,
  rankDreams,
  type DreamCandidate,
  type DreamInterest,
} from "./dream-ranking";

type Window = {
  id: string;
  viewer_key: string;
  cursor_key: string;
  ids: string[];
  more: boolean;
  after_time: string | null;
  after_id: string | null;
  snapshot_at: Date;
  expires_at: Date;
  next_window: string | null;
};
const viewerKey = (viewer: string | null) =>
  createHash("sha256")
    .update(JSON.stringify(["dream-feed-v1", viewer]))
    .digest("hex");
// pg's Date parser truncates microseconds; keep the scan boundary as exact SQL text.
const windowSelection = `SELECT *,to_char(after_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS after_time FROM app.dream_feed_windows`;
const sign = (window: Window, position: number) =>
  createHmac("sha256", window.cursor_key)
    .update(`v1:${window.id}:${position}:${window.viewer_key}`)
    .digest("base64url");
function cursorFor(window: Window, position: number) {
  return `v1.${window.id}.${position}.${sign(window, position)}`;
}
function parseCursor(raw: string) {
  const parts = raw.split(".");
  if (
    raw.length > 160 ||
    parts.length !== 4 ||
    parts[0] !== "v1" ||
    !validDreamId(parts[1]) ||
    !/^(?:0|[1-9]\d?)$/.test(parts[2]) ||
    !/^[\w-]{43}$/.test(parts[3])
  )
    throw new DreamError("INVALID_FEED_CURSOR", 400);
  return { id: parts[1], position: Number(parts[2]), signature: parts[3] };
}
async function newWindow(
  db: PoolClient,
  viewer: string | null,
  previous?: Window,
): Promise<Window> {
  const snapshot = previous?.snapshot_at ?? new Date();
  // Limit the indexed scan BEFORE authorization, so a long private stretch stays bounded.
  const scanned = (
    await db.query(
      `SELECT d.id,d.author_id,d.published_at,d.audience,d.buss_up_count,d.buss_down_count,
      to_char(d.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS boundary,
      (${eligibleDream}) AS eligible,
      EXISTS(SELECT 1 FROM app.friendships f WHERE f.player_id=$2 AND f.other_player_id=d.author_id AND f.state='accepted')
      AND EXISTS(SELECT 1 FROM app.friendships f WHERE f.player_id=d.author_id AND f.other_player_id=$2 AND f.state='accepted') AS friend,
      COALESCE((SELECT value FROM app.dream_votes WHERE dream_id=d.id AND voter_id=$2),0) AS vote
     FROM app.dreams d WHERE d.publication='published' AND d.moderation='visible' AND d.published_at<=$1
      AND ($3::timestamptz IS NULL OR (d.published_at,d.id)<($3::timestamptz,$4::uuid))
     ORDER BY d.published_at DESC,d.id DESC LIMIT $5`,
      [
        snapshot,
        viewer,
        previous?.after_time ?? null,
        previous?.after_id ?? null,
        DREAM_WINDOW + 1,
      ],
    )
  ).rows;
  const page = scanned.slice(0, DREAM_WINDOW),
    last = page.at(-1);
  const candidates: DreamCandidate[] = page
    .filter((row) => row.eligible)
    .map((row) => ({
      id: row.id,
      author: row.author_id,
      publishedAt: row.published_at.getTime(),
      audience: row.audience,
      up: row.buss_up_count,
      down: row.buss_down_count,
      friend: row.friend,
      vote: row.vote,
    }));
  // Only current explicit votes on still-readable published Dreams are interest signals.
  const interests: DreamInterest[] = viewer
    ? (
        await db.query(
          `SELECT d.author_id,v.value,v.updated_at FROM
      (SELECT dream_id,value,updated_at FROM app.dream_votes WHERE voter_id=$1 AND updated_at>now()-interval '90 days'
       ORDER BY updated_at DESC,dream_id DESC LIMIT 100) v
      JOIN app.dreams d ON d.id=v.dream_id
      WHERE d.publication='published' AND d.moderation='visible' AND ${eligibleDream.replaceAll("$2", "$1")}`,
          [viewer],
        )
      ).rows.map((row) => ({
        author: row.author_id,
        value: row.value,
        at: row.updated_at.getTime(),
      }))
    : [];
  const window: Window = {
    id: randomUUID(),
    viewer_key: viewerKey(viewer),
    cursor_key: randomBytes(32).toString("hex"),
    ids: rankDreams(candidates, interests, viewer, snapshot.getTime()).map(
      (row) => row.id,
    ),
    more: scanned.length > DREAM_WINDOW,
    after_time: last?.boundary ?? null,
    after_id: last?.id ?? null,
    snapshot_at: snapshot,
    expires_at: previous?.expires_at ?? new Date(snapshot.getTime() + 15 * 60_000),
    next_window: null,
  };
  await db.query(
    `INSERT INTO app.dream_feed_windows(id,viewer_key,cursor_key,ids,more,after_time,after_id,snapshot_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      window.id,
      window.viewer_key,
      window.cursor_key,
      window.ids,
      window.more,
      window.after_time,
      window.after_id,
      window.snapshot_at,
      window.expires_at,
    ],
  );
  return window;
}

export async function listDreamFeed(viewer: string | null, raw: string | null) {
  const cursor = raw ? parseCursor(raw) : null;
  return withDreamDb(async (db) => {
    if (
      viewer &&
      (
        await db.query(
          "SELECT 1 FROM app.player_deletions WHERE player_id=$1",
          [viewer],
        )
      ).rowCount
    )
      throw new DreamError("ACCOUNT_UNAVAILABLE", 403);
    let window: Window,
      position = cursor?.position ?? 0;
    if (cursor) {
      const result = (
        await db.query<Window>(
          `${windowSelection} WHERE id=$1 AND viewer_key=$2 FOR UPDATE`,
          [cursor.id, viewerKey(viewer)],
        )
      ).rows[0];
      if (!result) throw new DreamError("INVALID_FEED_CURSOR", 400);
      if (result.expires_at.getTime() <= Date.now())
        throw new DreamError("FEED_CURSOR_EXPIRED", 410);
      const expected = Buffer.from(sign(result, position)),
        actual = Buffer.from(cursor.signature);
      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual) ||
        position > result.ids.length
      )
        throw new DreamError("INVALID_FEED_CURSOR", 400);
      window = result;
      if (position === window.ids.length && window.more) {
        if (window.next_window)
          window = (
            await db.query<Window>(`${windowSelection} WHERE id=$1`, [
              window.next_window,
            ])
          ).rows[0];
        else {
          const next = await newWindow(db, viewer, window);
          await db.query(
            "UPDATE app.dream_feed_windows SET next_window=$2 WHERE id=$1",
            [window.id, next.id],
          );
          window = next;
        }
        position = 0;
      }
    } else {
      // Opportunistic bounded expiry; no scheduler or background service.
      await db.query(
        "DELETE FROM app.dream_feed_windows WHERE id IN (SELECT id FROM app.dream_feed_windows WHERE expires_at<=now() ORDER BY expires_at LIMIT 100)",
      );
      window = await newWindow(db, viewer);
    }
    if (!window) throw new DreamError('FEED_CURSOR_EXPIRED',410);
    const ids = window.ids.slice(position, position + DREAM_BATCH);
    const rows = ids.length
      ? (
          await db.query<DreamRow>(
            `SELECT d.*,p.username,p.avatar_key FROM app.dreams d LEFT JOIN app.player_profiles p ON p.id=d.author_id
       WHERE d.id=ANY($1::uuid[]) AND d.publication='published' AND d.moderation='visible' AND ${eligibleDream}
       ORDER BY array_position($1::uuid[],d.id)`,
            [ids, viewer],
          )
        ).rows
      : [];
    position += ids.length;
    return {
      dreams: await presentDreams(db, rows, viewer, false),
      nextCursor:
        position < window.ids.length || window.more
          ? cursorFor(window, position)
          : null,
    };
  });
}
