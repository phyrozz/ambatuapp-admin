import { withDevLeaderboardDb } from './dev-content-db';
import { playerDisplayProfiles } from './player-profiles';

const games = ['ambatutap', 'ambatusnake', 'ambatublou', 'flappy-bus'] as const;
type Game = typeof games[number];
function scoreNumber(value: string) {
  const score = Number(value);
  if (!Number.isSafeInteger(score) || score < 0) throw new Error('Invalid leaderboard score');
  return score;
}
export async function topScores(gameId: string) {
  const rows = await withDevLeaderboardDb(async db => (await db.query<{ player_id: string; player_label: string | null; score: string; updated_at: Date | null }>(
    `SELECT player_id,player_label,score,updated_at FROM app.leaderboard_entries WHERE game_id=$1
      ORDER BY score DESC,updated_at ASC NULLS LAST,player_id COLLATE "C" ASC LIMIT 20`, [gameId])).rows);
  const profiles = await playerDisplayProfiles(rows.map(row => row.player_id), new Map(rows.map(row => [row.player_id, row.player_label ?? 'Player'])));
  return rows.map((row, index) => ({ rank: index + 1, player: profiles.get(row.player_id)?.username ?? row.player_label,
    avatarUrl: profiles.get(row.player_id)?.avatarUrl ?? null, score: scoreNumber(row.score), updatedAt: row.updated_at?.toISOString() ?? null }));
}
export async function submitScore(gameId: string, playerId: string, score: number) {
  await withDevLeaderboardDb(async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`leaderboard:${playerId}`]);
    await db.query(`INSERT INTO app.leaderboard_entries (game_id,player_id,player_label,score,updated_at) VALUES ($1,$2,$3,$4,now())
    ON CONFLICT (game_id,player_id) DO UPDATE SET player_label=EXCLUDED.player_label,score=EXCLUDED.score,updated_at=EXCLUDED.updated_at
    WHERE app.leaderboard_entries.score<EXCLUDED.score`, [gameId, playerId, `Player ${playerId.slice(0, 6)}`, score]);
  });
}
export async function syncScores(playerId: string, localScores: Partial<Record<Game, number>>) {
  return withDevLeaderboardDb(async db => {
    // Serialize this player's score submissions and multi-game syncs.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`leaderboard:${playerId}`]);
    const result: Record<string, number> = {};
    for (const game of games) {
      const incoming = localScores[game] ?? 0;
      if (incoming > 0) await db.query(`INSERT INTO app.leaderboard_entries (game_id,player_id,player_label,score,updated_at) VALUES ($1,$2,$3,$4,now())
        ON CONFLICT (game_id,player_id) DO UPDATE SET player_label=EXCLUDED.player_label,score=EXCLUDED.score,updated_at=EXCLUDED.updated_at
        WHERE app.leaderboard_entries.score<EXCLUDED.score`, [game, playerId, `Player ${playerId.slice(0, 6)}`, incoming]);
      const current = await db.query<{ score: string }>('SELECT score FROM app.leaderboard_entries WHERE game_id=$1 AND player_id=$2', [game, playerId]);
      result[game] = current.rows[0] ? scoreNumber(current.rows[0].score) : 0;
    }
    return result;
  });
}
