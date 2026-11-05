import { withDevSocialDb, withDevVideoDb } from './dev-content-db';
import { getScrollVideos } from './dev-videos';
import { mergeScrollHistory, personalizedScrollPage, recentHistory, scrollTopics, SCROLL_WINDOW,
  type ScrollCandidate, type ScrollHistory, type ScrollRefresh, type ScrollSignals, type WatchSignal } from './scroll-ranking';

type CandidateRow = { id: string; uploader_id: string | null; title: string | null; description: string | null;
  created_at: Date; cursor_time: string; upvotes: string; downvotes: string; user_vote: number | null };
const candidateSelect = `SELECT c.id,c.uploader_id,c.created_at,c.upvotes,c.downvotes,v.title,v.description,vote.value AS user_vote,
  to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
  FROM app.content c JOIN app.videos v ON v.id=c.id AND v.kind=c.kind
  LEFT JOIN app.content_votes vote ON vote.content_kind=c.kind AND vote.content_id=c.id AND vote.voter_key=$1
  WHERE c.kind='video' AND c.status='Published' AND c.created_at IS NOT NULL AND v.video_key IS NOT NULL AND v.video_key<>''`;
function candidate(row: CandidateRow): ScrollCandidate {
  return { id: row.id, creator: row.uploader_id, title: row.title ?? '', description: row.description ?? '',
    createdAt: row.created_at.getTime(), upvotes: Number(row.upvotes), downvotes: Number(row.downvotes), vote: row.user_vote ?? 0 };
}
function boundary(raw: string | null): { time: string; id: string } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (typeof value.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value.time)
      || !Number.isFinite(Date.parse(value.time)) || typeof value.id !== 'string' || !/^[\w-]{1,128}$/.test(value.id)) throw new Error();
    return value;
  } catch { throw new Error('INVALID_CURSOR'); }
}

export async function scrollCandidateWindow(playerId: string, after: string | null, exclude: string[] = []) {
  const cursor = boundary(after);
  const rows = await withDevVideoDb(async db => (await db.query<CandidateRow>(`${candidateSelect}
    AND ($2::timestamptz IS NULL OR (c.created_at,c.id COLLATE "C")<($2::timestamptz,$3 COLLATE "C"))
    AND NOT (c.id=ANY($5::text[]))
    ORDER BY c.created_at DESC,c.id COLLATE "C" DESC LIMIT $4`,
  [`user:${playerId}`, cursor?.time ?? null, cursor?.id ?? null, SCROLL_WINDOW + 1, exclude])).rows);
  const page = rows.slice(0, SCROLL_WINDOW), last = page.at(-1);
  return { candidates: page.map(candidate), after: last ? JSON.stringify({ time: last.cursor_time, id: last.id }) : null, more: rows.length > SCROLL_WINDOW };
}

export async function scrollSignals(playerId: string, candidates: ScrollCandidate[]): Promise<ScrollSignals> {
  const [preferences, following] = await Promise.all([
    withDevVideoDb(async db => {
      const result = await db.query<{ history: ScrollHistory[] }>('SELECT history FROM app.scroll_preferences WHERE player_id=$1', [playerId]);
      const watched = recentHistory(result.rows[0]?.history ?? []);
      // Seed existing accounts from their latest explicit votes, even before they watch in this feed.
      const recentVotes = (await db.query<{ id: string; creator: string | null; title: string; description: string; value: number; at: Date }>(`
        SELECT c.id,c.uploader_id AS creator,v.title,v.description,vote.value,coalesce(vote.updated_at,c.created_at) AS at
        FROM (SELECT content_id,value,updated_at FROM app.content_votes WHERE voter_key=$1 AND content_kind='video' AND value<>0
          ORDER BY updated_at DESC NULLS LAST,content_id LIMIT 100) vote
        JOIN app.content c ON c.kind='video' AND c.id=vote.content_id AND c.status='Published'
        JOIN app.videos v ON v.id=c.id WHERE coalesce(vote.updated_at,c.created_at)>now()-interval '90 days'`, [`user:${playerId}`])).rows;
      const watchedIds = new Set(watched.map(item => item.id));
      const history = recentHistory([...watched, ...recentVotes.filter(row => !watchedIds.has(row.id)).map(row => ({
        id: row.id, creator: row.creator, topics: scrollTopics(row.title ?? '', row.description ?? ''), watchedMs: 0, durationMs: 1, at: row.at.getTime(),
      }))]);
      const votes = history.length ? (await db.query<{ content_id: string; value: number }>(
        "SELECT content_id,value FROM app.content_votes WHERE content_kind='video' AND voter_key=$1 AND content_id=ANY($2::text[])",
        [`user:${playerId}`, history.map(item => item.id)])).rows : [];
      return { history, votes: new Map(votes.map(row => [row.content_id, row.value])) };
    }),
    withDevSocialDb(async db => (await db.query<{ followed_id: string }>(
      'SELECT followed_id FROM app.follows WHERE follower_id=$1 AND followed_id=ANY($2::text[])',
      [playerId, [...new Set(candidates.flatMap(clip => clip.creator ? [clip.creator] : []))]])).rows),
  ]);
  return { ...preferences, following: new Set(following.map(row => row.followed_id)) };
}

export function listPersonalizedScroll(playerId: string, raw: string | null, refresh?: ScrollRefresh) {
  return personalizedScrollPage({ backend: 'postgres', scan: (after, exclude) => scrollCandidateWindow(playerId, after, exclude),
    signals: candidates => scrollSignals(playerId, candidates), hydrate: ids => getScrollVideos(playerId, ids) }, playerId, raw, refresh);
}

export async function recordScrollWatch(playerId: string, id: string, signal: WatchSignal) {
  return withDevVideoDb(async db => {
    const clip = (await db.query<CandidateRow>(`${candidateSelect} AND c.id=$2`, [`user:${playerId}`, id])).rows[0];
    if (!clip) return false;
    await db.query('INSERT INTO app.scroll_preferences (player_id) VALUES ($1) ON CONFLICT DO NOTHING', [playerId]);
    const prior = await db.query<{ history: ScrollHistory[] }>('SELECT history FROM app.scroll_preferences WHERE player_id=$1 FOR UPDATE', [playerId]);
    const history = mergeScrollHistory(prior.rows[0]?.history ?? [], candidate(clip), signal);
    await db.query('UPDATE app.scroll_preferences SET history=$2::jsonb,updated_at=now() WHERE player_id=$1', [playerId, JSON.stringify(history)]);
    return true;
  });
}
