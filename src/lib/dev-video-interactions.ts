import { randomUUID } from 'node:crypto';
import { withDevVideoDb } from './dev-content-db';
import { encodeLoreCommentCursor, parseLoreCommentCursor } from './lore-comment-cursor';
import { profileAvatarUrl } from './profile-avatars';
import { fallbackPlayerName } from './player-profiles';

type CommentRow = { id: string; body: string | null; author_id: string | null; author_name: string | null; author_email: string | null;
  parent_id: string | null; created_at: Date | null; cursor_time: string | null; upvotes: string; downvotes: string;
  username: string | null; avatar_key: string | null; user_vote: number | null };
function count(value: string) { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid comment counter'); return n; }

export async function listVideoComments(id: string, playerId: string | null, url: URL) {
  const n = Number(url.searchParams.get('limit')) || 20, limit = Math.min(50, Math.max(1, Math.floor(Number.isFinite(n) ? n : 20)));
  const cursor = parseLoreCommentCursor(url.searchParams.get('cursor'), `video:${id}`);
  const rows = await withDevVideoDb(async db => {
    const video = await db.query("SELECT 1 FROM app.content WHERE kind='video' AND id=$1 AND status='Published'", [id]);
    if (!video.rowCount) return null;
    return (await db.query<CommentRow>(`SELECT m.id,m.body,m.author_id,m.author_name,m.author_email,m.parent_id,m.created_at,m.upvotes,m.downvotes,
      to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,
      p.username,p.avatar_key,v.value AS user_vote FROM app.comments m
      LEFT JOIN app.player_profiles p ON p.id=m.author_id
      LEFT JOIN app.comment_votes v ON v.content_kind=m.content_kind AND v.content_id=m.content_id AND v.comment_id=m.id AND v.voter_key=$2
      WHERE m.content_kind='video' AND m.content_id=$1
      AND ($3::text IS NULL OR ($4::timestamptz IS NULL AND m.created_at IS NULL AND m.id COLLATE "C"<$3 COLLATE "C")
        OR ($4::timestamptz IS NOT NULL AND (m.created_at<$4 OR m.created_at IS NULL OR (m.created_at=$4 AND m.id COLLATE "C"<$3 COLLATE "C"))))
      ORDER BY m.created_at DESC NULLS LAST,m.id COLLATE "C" DESC LIMIT $5`, [id, playerId ? `user:${playerId}` : null, cursor?.id ?? null, cursor?.time ?? null, limit + 1])).rows;
  });
  if (!rows) return null;
  const page = rows.slice(0, limit), last = page.at(-1);
  const comments = await Promise.all(page.map(async row => ({ id: row.id, text: row.body, author: row.author_email ? row.username || row.author_name || fallbackPlayerName(row.author_email) : row.author_name ?? 'Anonymous',
    avatarUrl: row.author_id && row.author_email ? await profileAvatarUrl(row.avatar_key ?? undefined) : null, authorId: row.author_email ? row.author_id : null, parentId: row.parent_id,
    createdAt: row.created_at?.toISOString() ?? null, upvotes: count(row.upvotes), downvotes: count(row.downvotes), userVote: row.user_vote ?? 0 })));
  return { comments, nextCursor: rows.length > limit && last ? encodeLoreCommentCursor({ v: 1, loreId: `video:${id}`, id: last.id, time: last.cursor_time }) : null };
}

export async function createVideoComment(videoId: string, player: { id: string; email: string }, text: string, parentId: string | null) {
  const id = randomUUID();
  const result = await withDevVideoDb(async db => {
    const video = await db.query("SELECT 1 FROM app.content WHERE kind='video' AND id=$1 AND status='Published' FOR UPDATE", [videoId]);
    if (!video.rowCount) throw new Error('Video not found.');
    if (parentId && !(await db.query("SELECT 1 FROM app.comments WHERE content_kind='video' AND content_id=$1 AND id=$2", [videoId, parentId])).rowCount) throw new Error('Comment not found.');
    const profile = (await db.query('SELECT username,avatar_key FROM app.player_profiles WHERE id=$1', [player.id])).rows[0];
    const author = profile?.username || fallbackPlayerName(player.email);
    const inserted = await db.query(`INSERT INTO app.comments (content_kind,content_id,id,parent_id,body,author_id,author_name,author_email,created_at)
      VALUES ('video',$1,$2,$3,$4,$5,$6,$7,now()) RETURNING created_at`, [videoId, id, parentId, text.trim(), player.id, author, player.email]);
    await db.query("UPDATE app.content SET comment_count=comment_count+1 WHERE kind='video' AND id=$1", [videoId]);
    return { author, avatarKey: profile?.avatar_key as string | undefined, createdAt: inserted.rows[0].created_at as Date };
  });
  return { id, text: text.trim(), author: result.author, avatarUrl: await profileAvatarUrl(result.avatarKey), authorId: player.id, parentId,
    createdAt: result.createdAt.toISOString(), upvotes: 0, downvotes: 0, userVote: 0 };
}

export async function voteVideo(videoId: string, voterId: string, value: 1 | -1, commentId?: string) {
  return withDevVideoDb(async db => {
    const video = await db.query("SELECT upvotes,downvotes FROM app.content WHERE kind='video' AND id=$1 AND status='Published' FOR UPDATE", [videoId]);
    if (!video.rowCount) throw new Error('Video not found.');
    const comment = commentId ? await db.query("SELECT upvotes,downvotes FROM app.comments WHERE content_kind='video' AND content_id=$1 AND id=$2 FOR UPDATE", [videoId, commentId]) : null;
    if (commentId && !comment?.rowCount) throw new Error('Comment not found.');
    const existing = commentId
      ? await db.query("SELECT value FROM app.comment_votes WHERE content_kind='video' AND content_id=$1 AND comment_id=$2 AND voter_key=$3", [videoId, commentId, `user:${voterId}`])
      : await db.query("SELECT value FROM app.content_votes WHERE content_kind='video' AND content_id=$1 AND voter_key=$2", [videoId, `user:${voterId}`]);
    const prior = existing.rows[0]?.value === 1 || existing.rows[0]?.value === -1 ? existing.rows[0].value as number : 0;
    const next = prior === value ? 0 : value;
    const upvotes = Math.max(0, count((comment?.rows[0] ?? video.rows[0]).upvotes) + Number(next === 1) - Number(prior === 1));
    const downvotes = Math.max(0, count((comment?.rows[0] ?? video.rows[0]).downvotes) + Number(next === -1) - Number(prior === -1));
    if (commentId) {
      await db.query(`INSERT INTO app.comment_votes (content_kind,content_id,comment_id,voter_key,value,updated_at) VALUES ('video',$1,$2,$3,$4,now())
        ON CONFLICT (content_kind,content_id,comment_id,voter_key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [videoId, commentId, `user:${voterId}`, next]);
      await db.query("UPDATE app.comments SET upvotes=$3,downvotes=$4 WHERE content_kind='video' AND content_id=$1 AND id=$2", [videoId, commentId, upvotes, downvotes]);
    } else {
      await db.query(`INSERT INTO app.content_votes (content_kind,content_id,voter_key,value,updated_at) VALUES ('video',$1,$2,$3,now())
        ON CONFLICT (content_kind,content_id,voter_key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [videoId, `user:${voterId}`, next]);
      await db.query("UPDATE app.content SET upvotes=$2,downvotes=$3 WHERE kind='video' AND id=$1", [videoId, upvotes, downvotes]);
    }
    return { value: next, upvotes, downvotes };
  });
}
