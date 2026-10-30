import type { PoolClient } from 'pg';
import { withDevSocialDb } from './dev-content-db';
import { friendTransition, type FriendState } from './friend-state';
import { followTransition, reciprocalFriendState, type FollowAction } from './follow-state';
import { nextFriendCursor, type FriendFilter } from './friend-list';

type Relation = { state: FriendState; pinned: boolean };
async function lockPair(db: PoolClient, first: string, second: string) {
  const pair = [first, second].sort().join(':');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [pair]);
}
async function getRelation(db: PoolClient, playerId: string, otherId: string) {
  return (await db.query<Relation>('SELECT state,pinned FROM app.friendships WHERE player_id=$1 AND other_player_id=$2', [playerId, otherId])).rows[0];
}
async function writePair(db: PoolClient, playerId: string, otherId: string, first: FriendState, second: FriendState) {
  await db.query(`INSERT INTO app.friendships (player_id,other_player_id,state,updated_at) VALUES ($1,$2,$3,now()),($2,$1,$4,now())
    ON CONFLICT (player_id,other_player_id) DO UPDATE SET state=EXCLUDED.state,updated_at=EXCLUDED.updated_at`, [playerId, otherId, first, second]);
}
async function deletePair(db: PoolClient, playerId: string, otherId: string) {
  await db.query('DELETE FROM app.friendships WHERE (player_id=$1 AND other_player_id=$2) OR (player_id=$2 AND other_player_id=$1)', [playerId, otherId]);
}
export async function changeFriend(playerId: string, otherId: string, action: 'request' | 'accept' | 'remove' | 'pin' | 'unpin') {
  return withDevSocialDb(async db => {
    await lockPair(db, playerId, otherId);
    const current = await getRelation(db, playerId, otherId);
    if (action === 'pin' || action === 'unpin') {
      if (current?.state !== 'accepted') throw new Error('INVALID_FRIEND_TRANSITION');
      await db.query('UPDATE app.friendships SET pinned=$3 WHERE player_id=$1 AND other_player_id=$2', [playerId, otherId, action === 'pin']);
      return { state: 'accepted' as const, pinned: action === 'pin', notify: false };
    }
    const next = friendTransition(current?.state, action);
    if (!next) { await deletePair(db, playerId, otherId); return { state: null, pinned: false, notify: false }; }
    await writePair(db, playerId, otherId, next[0], next[1]);
    return { state: next[0], pinned: current?.pinned === true, notify: action === 'request' && !current };
  });
}
export async function changeFollow(playerId: string, otherId: string, action: FollowAction) {
  return withDevSocialDb(async db => {
    await lockPair(db, playerId, otherId);
    const current = await getRelation(db, playerId, otherId);
    const exists = Boolean((await db.query('SELECT 1 FROM app.follows WHERE follower_id=$1 AND followed_id=$2', [playerId, otherId])).rowCount);
    const next = followTransition(exists, current?.state ?? null, action);
    if (next.following) await db.query('INSERT INTO app.follows (follower_id,followed_id,created_at) VALUES ($1,$2,now()) ON CONFLICT DO NOTHING', [playerId, otherId]);
    else await db.query('DELETE FROM app.follows WHERE follower_id=$1 AND followed_id=$2', [playerId, otherId]);
    if (next.writeFriendship) {
      if (next.state) await writePair(db, playerId, otherId, next.state, reciprocalFriendState(next.state));
      else await deletePair(db, playerId, otherId);
    }
    return next;
  });
}
export async function listFriends(playerId: string, filter: FriendFilter, cursor: string | null) {
  const rows = await withDevSocialDb(async db => (await db.query<{ other_player_id: string; state: FriendState; pinned: boolean }>(
    `SELECT other_player_id,state,pinned FROM app.friendships WHERE player_id=$1 AND ($2::text IS NULL OR state=$2)
      AND (NOT $3::boolean OR (pinned AND state='accepted')) AND ($4::text IS NULL OR other_player_id COLLATE "C">$4 COLLATE "C")
      ORDER BY other_player_id COLLATE "C" LIMIT 21`, [playerId, filter.state, filter.pinned, cursor])).rows);
  const page = rows.slice(0, 20), last = page.at(-1);
  return { rows: page, nextCursor: rows.length > 20 && last ? nextFriendCursor(last.other_player_id, filter) : null };
}
export async function friendRelationships(playerId: string, ids: string[]) {
  if (!ids.length) return new Map<string, Relation>();
  return withDevSocialDb(async db => {
    const rows = (await db.query<Relation & { other_player_id: string }>('SELECT other_player_id,state,pinned FROM app.friendships WHERE player_id=$1 AND other_player_id=ANY($2)', [playerId, ids])).rows;
    return new Map(rows.map(row => [row.other_player_id, { state: row.state, pinned: row.pinned }]));
  });
}
export async function socialCounts(id: string, viewerId: string) {
  return withDevSocialDb(async db => {
    const result = await db.query(`SELECT
      (SELECT count(*)::int FROM app.follows WHERE followed_id=$1) AS followers,
      (SELECT count(*)::int FROM app.friendships WHERE player_id=$1 AND state='accepted') AS friends,
      (SELECT count(*)::int FROM app.friendships WHERE player_id=$1 AND state='incoming') AS incoming,
      EXISTS (SELECT 1 FROM app.follows WHERE follower_id=$2 AND followed_id=$1) AS following,
      (SELECT state FROM app.friendships WHERE player_id=$2 AND other_player_id=$1) AS state`, [id, viewerId]);
    const row = result.rows[0];
    return { followers: row.followers as number, friends: row.friends as number, incoming: row.incoming as number, following: row.following as boolean, state: (row.state ?? null) as FriendState | null };
  });
}
