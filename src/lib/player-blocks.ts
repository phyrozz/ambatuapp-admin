import type { PoolClient } from 'pg';
import { isDevSocialWriter, withDevSocialDb } from './dev-content-db';

/** Same lock as friendship/follow transitions: a block must win concurrent requests. */
export async function assertNoPlayerBlock(db: PoolClient, viewerId: string, targetId: string) {
  const result = await db.query('SELECT 1 FROM app.player_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1', [viewerId, targetId]);
  if (result.rowCount) throw new Error('PLAYER_NOT_FOUND');
}

/** Both directions are hidden; callers must not fall back to cached profile data. */
export async function hiddenPlayerIds(viewerId: string | null | undefined, ids: readonly string[]) {
  if (!viewerId || !ids.length) return new Set<string>();
  if (!isDevSocialWriter()) {
    if (process.env.PLAYER_BLOCKS_ENABLED === 'true') throw new Error('BLOCKS_UNAVAILABLE');
    return new Set<string>(); // Legacy environments where blocking has never been enabled.
  }
  return withDevSocialDb(async db => {
    const result = await db.query<{ id: string }>(`SELECT CASE WHEN blocker_id=$1 THEN blocked_id ELSE blocker_id END AS id
      FROM app.player_blocks WHERE (blocker_id=$1 AND blocked_id=ANY($2::text[])) OR (blocked_id=$1 AND blocker_id=ANY($2::text[]))`, [viewerId, [...new Set(ids)]]);
    return new Set(result.rows.map(row => row.id));
  });
}

export async function changePlayerBlock(viewerId: string, targetId: string, blocked: boolean) {
  return withDevSocialDb(async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [[viewerId, targetId].sort().join(':')]);
    if (blocked) {
      await db.query('INSERT INTO app.player_blocks (blocker_id,blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [viewerId, targetId]);
      await db.query('DELETE FROM app.friendships WHERE (player_id=$1 AND other_player_id=$2) OR (player_id=$2 AND other_player_id=$1)', [viewerId, targetId]);
      await db.query('DELETE FROM app.follows WHERE (follower_id=$1 AND followed_id=$2) OR (follower_id=$2 AND followed_id=$1)', [viewerId, targetId]);
    } else {
      await db.query('DELETE FROM app.player_blocks WHERE blocker_id=$1 AND blocked_id=$2', [viewerId, targetId]);
    }
    return { blocked };
  });
}

export async function listPlayerBlocks(viewerId: string, cursor: string | null) {
  return withDevSocialDb(async db => {
    const result = await db.query<{ id: string }>(`SELECT blocked_id AS id FROM app.player_blocks
      WHERE blocker_id=$1 AND ($2::text IS NULL OR blocked_id COLLATE "C">$2 COLLATE "C") ORDER BY blocked_id COLLATE "C" LIMIT 21`, [viewerId, cursor]);
    const items = result.rows.slice(0, 20);
    return { items, nextCursor: result.rows.length > 20 ? items.at(-1)!.id : null };
  });
}

/** Primary-database policy input for future Dream reads, interactions and media. */
export async function dreamRelationship(viewerId: string | null, authorId: string) {
  if (!viewerId || viewerId === authorId) return { blocked: false, acceptedByViewer: false, acceptedByAuthor: false };
  return withDevSocialDb(async db => {
    const row = (await db.query<{ blocked: boolean; accepted_by_viewer: boolean; accepted_by_author: boolean }>(`SELECT
      EXISTS (SELECT 1 FROM app.player_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)) AS blocked,
      EXISTS (SELECT 1 FROM app.friendships WHERE player_id=$1 AND other_player_id=$2 AND state='accepted') AS accepted_by_viewer,
      EXISTS (SELECT 1 FROM app.friendships WHERE player_id=$2 AND other_player_id=$1 AND state='accepted') AS accepted_by_author`, [viewerId, authorId])).rows[0];
    return { blocked: row.blocked, acceptedByViewer: row.accepted_by_viewer, acceptedByAuthor: row.accepted_by_author };
  });
}
