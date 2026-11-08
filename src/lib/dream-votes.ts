import type { PoolClient } from "pg";
import { withDreamDb } from "./dev-content-db";
import { DreamError, dreamVoteBody } from "./dream-validation";
import { eligibleDream } from "../../dream-media/core.mjs";

export type DreamVotes = { up: number; down: number; viewerVote: -1 | 0 | 1 };

export async function dreamVotes(
  db: PoolClient,
  id: string,
  viewer: string | null,
): Promise<DreamVotes> {
  const row = (
    await db.query(
      `SELECT d.buss_up_count,d.buss_down_count,COALESCE(v.value,0) AS viewer_vote
     FROM app.dreams d LEFT JOIN app.dream_votes v ON v.dream_id=d.id AND v.voter_id=$2
     WHERE d.id=$1`,
      [id, viewer],
    )
  ).rows[0];
  return {
    up: row.buss_up_count,
    down: row.buss_down_count,
    viewerVote: row.viewer_vote,
  };
}

/** Explicit desired state, not a toggle command: network retries cannot undo a vote. */
export async function voteDream(
  id: string,
  voter: string,
  body: unknown,
  key: string,
) {
  const value = dreamVoteBody(body);
  return withDreamDb(async (db) => {
    // Same lock as account deletion prevents votes being recreated after deletion starts.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `dream-author:${voter}`,
    ]);
    const eligible = await db.query(
      `SELECT d.id FROM app.dreams d WHERE d.id=$1 AND d.publication='published'
       AND d.moderation='visible' AND ${eligibleDream} FOR UPDATE OF d`,
      [id, voter],
    );
    if (!eligible.rowCount) throw new DreamError("DREAM_UNAVAILABLE", 404);
    const prior = (
      await db.query(
        "SELECT value FROM app.dream_vote_requests WHERE dream_id=$1 AND voter_id=$2 AND request_key=$3",
        [id, voter, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.value !== value)
        throw new DreamError("IDEMPOTENCY_CONFLICT", 409);
      // A delayed retry must not overwrite a newer selection.
      return dreamVotes(db, id, voter);
    }
    const budget = await db.query(
      `INSERT INTO app.dream_vote_budgets AS b(voter_id) VALUES($1)
       ON CONFLICT(voter_id) DO UPDATE SET
         minute_started=CASE WHEN b.minute_started<=now()-interval '1 minute' THEN now() ELSE b.minute_started END,
         minute_requests=CASE WHEN b.minute_started<=now()-interval '1 minute' THEN 1 ELSE b.minute_requests+1 END,
         day_started=CASE WHEN b.day_started<=now()-interval '24 hours' THEN now() ELSE b.day_started END,
         day_requests=CASE WHEN b.day_started<=now()-interval '24 hours' THEN 1 ELSE b.day_requests+1 END
       WHERE (b.minute_started<=now()-interval '1 minute' OR b.minute_requests<60)
         AND (b.day_started<=now()-interval '24 hours' OR b.day_requests<1000)
       RETURNING voter_id`,
      [voter],
    );
    if (!budget.rowCount) throw new DreamError("VOTE_RATE_LIMITED", 429);
    if (value === 0) {
      await db.query(
        "DELETE FROM app.dream_votes WHERE dream_id=$1 AND voter_id=$2",
        [id, voter],
      );
    } else {
      await db.query(
        `INSERT INTO app.dream_votes(dream_id,voter_id,value) VALUES($1,$2,$3)
         ON CONFLICT(dream_id,voter_id) DO UPDATE SET value=EXCLUDED.value,updated_at=now()
         WHERE dream_votes.value IS DISTINCT FROM EXCLUDED.value`,
        [id, voter, value],
      );
    }
    await db.query(
      "INSERT INTO app.dream_vote_requests(dream_id,voter_id,request_key,value) VALUES($1,$2,$3,$4)",
      [id, voter, key, value],
    );
    return dreamVotes(db, id, voter);
  });
}
