export const SCROLL_WINDOW = 24;
export const SCROLL_BATCH = 8;
export const HISTORY_LIMIT = 100;
export const HISTORY_TTL = 90 * 86400_000;

export type WatchSignal = { watchedMs: number; durationMs: number };
export type ScrollHistory = WatchSignal & { id: string; creator: string | null; topics: string[]; at: number };
export type ScrollCandidate = { id: string; creator: string | null; title: string; description: string; createdAt: number; upvotes: number; downvotes: number; vote: number };
export type ScrollSignals = { history: ScrollHistory[]; votes: Map<string, number>; following: Set<string> };

export function parseWatchSignal(value: unknown): WatchSignal {
  const data = value as WatchSignal | null;
  if (!data || !Number.isInteger(data.watchedMs) || data.watchedMs < 500 || data.watchedMs > 120_000
    || !Number.isInteger(data.durationMs) || data.durationMs < 1 || data.durationMs > 3600_000) throw new Error('INVALID_SIGNAL');
  return { watchedMs: data.watchedMs, durationMs: data.durationMs };
}

// Hashtags and title words supply a small, language-independent content signal.
export function scrollTopics(title: string, description: string): string[] {
  const hashtags = description.toLowerCase().match(/#[\p{L}\p{N}_]{2,40}/gu) ?? [];
  const words = title.toLowerCase().match(/[\p{L}\p{N}]{3,40}/gu) ?? [];
  const stop = new Set(['the', 'and', 'for', 'this', 'that', 'with', 'video', 'yang', 'dan', 'ini', 'itu', 'dari']);
  return [...new Set([...hashtags.map(word => word.slice(1)), ...words].filter(word => !stop.has(word)))].slice(0, 12);
}

export function recentHistory(history: ScrollHistory[], now = Date.now()): ScrollHistory[] {
  return history.filter(item => item.at > now - HISTORY_TTL && item.at <= now).sort((a, b) => b.at - a.at).slice(0, HISTORY_LIMIT);
}

export function mergeScrollHistory(history: ScrollHistory[], clip: ScrollCandidate, signal: WatchSignal, now = Date.now()): ScrollHistory[] {
  const current = recentHistory(history, now);
  const prior = current.find(item => item.id === clip.id);
  // Cumulative maxima make repeated checkpoints/retries idempotent, without rewarding loops.
  const watchedMs = Math.max(prior?.watchedMs ?? 0, signal.watchedMs);
  return [{ id: clip.id, creator: clip.creator, topics: scrollTopics(clip.title, clip.description), watchedMs,
    durationMs: prior && prior.watchedMs >= signal.watchedMs ? prior.durationMs : signal.durationMs, at: now },
  ...current.filter(item => item.id !== clip.id)].slice(0, HISTORY_LIMIT);
}

function jitter(playerId: string, id: string) {
  let hash = 2166136261;
  for (const char of `${playerId}:${id}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) / 4294967296;
}
const clamp = (n: number, max: number) => Math.max(-max, Math.min(max, n));

export function rankScrollCandidates(candidates: ScrollCandidate[], signals: ScrollSignals, playerId: string, now = Date.now(), seed = ''): ScrollCandidate[] {
  const history = recentHistory(signals.history, now), seen = new Set(history.map(item => item.id));
  const creators = new Map<string, number>(), topics = new Map<string, number>();
  for (const item of history) {
    const vote = signals.votes.get(item.id) ?? 0;
    const completion = Math.min(1, item.watchedMs / item.durationMs);
    const interest = vote === 1 ? 4 : vote === -1 ? -5 : completion >= 0.8 ? 2 : item.watchedMs >= 10_000 ? 1 : completion < 0.2 && item.watchedMs < 2000 ? -1 : 0;
    const weight = interest * Math.pow(0.5, (now - item.at) / (14 * 86400_000));
    if (item.creator) creators.set(item.creator, (creators.get(item.creator) ?? 0) + weight);
    for (const topic of item.topics) topics.set(topic, (topics.get(topic) ?? 0) + weight);
  }
  const pool = candidates.map(clip => {
    const words = scrollTopics(clip.title, clip.description);
    const affinity = clamp(words.reduce((sum, word) => sum + (topics.get(word) ?? 0), 0) / Math.max(1, words.length), 3);
    const base = 2 / (1 + Math.max(0, now - clip.createdAt) / (7 * 86400_000))
      + clamp(Math.log1p(Math.max(0, clip.upvotes)) - Math.log1p(Math.max(0, clip.downvotes)), 2) * 0.5
      + jitter(`${playerId}:${seed}`, clip.id) * 0.75 - (seen.has(clip.id) ? 5 : 0) + (clip.vote === -1 ? -20 : clip.vote === 1 ? -2 : 0);
    return { clip, base, score: base + affinity + (clip.creator ? clamp(creators.get(clip.creator) ?? 0, 6) + (signals.following.has(clip.creator) ? 4 : 0) : 0) };
  });
  const result: ScrollCandidate[] = [], counts = new Map<string, number>();
  while (pool.length) {
    // Every fourth slot explores; all slots discourage consecutive/repeated creators.
    const explore = result.length % 4 === 3;
    const score = (item: typeof pool[number]) => (explore ? item.base : item.score)
      - (item.clip.creator ? (counts.get(item.clip.creator) ?? 0) * 1.5 + (result.at(-1)?.creator === item.clip.creator ? 4 : 0) : 0);
    pool.sort((a, b) => score(b) - score(a) || a.clip.id.localeCompare(b.clip.id));
    const next = pool.shift()!.clip;
    result.push(next);
    if (next.creator) counts.set(next.creator, (counts.get(next.creator) ?? 0) + 1);
  }
  return result;
}

export type ScrollRefresh = { seed: string; exclude: string[] };
function validRefresh(seed: unknown, exclude: unknown): exclude is string[] {
  return typeof seed === 'string' && /^[\w-]{0,64}$/.test(seed) && Array.isArray(exclude) && exclude.length <= 32
    && exclude.every(id => typeof id === 'string' && /^[\w-]{1,128}$/.test(id))
    && exclude.join(',').length <= 1536 && new Set(exclude).size === exclude.length;
}
export function parseScrollRefresh(params: URLSearchParams): ScrollRefresh {
  const seed = params.get('seed') ?? '', raw = params.get('exclude') ?? '';
  if (raw.length > 1536) throw new Error('INVALID_REFRESH');
  const exclude = raw ? raw.split(',') : [];
  if (!validRefresh(seed, exclude)) throw new Error('INVALID_REFRESH');
  return { seed, exclude };
}
export type ScrollCursor = { version: 1; playerId: string; backend: string; after: string | null; pending: string[]; more: boolean; seed?: string; exclude?: string[] };
export function parseScrollCursor(raw: string | null, playerId: string, backend: string): ScrollCursor | null {
  if (!raw) return null;
  try {
    if (raw.length > 8192) throw new Error();
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString()) as ScrollCursor;
    if (c.version !== 1 || c.playerId !== playerId || c.backend !== backend || typeof c.more !== 'boolean'
      || (c.after !== null && (typeof c.after !== 'string' || c.after.length > 1024)) || (c.more && !c.after)
      || !Array.isArray(c.pending) || c.pending.length > SCROLL_WINDOW
      || c.pending.some(id => typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) || new Set(c.pending).size !== c.pending.length
      || !validRefresh(c.seed ?? '', c.exclude ?? [])) throw new Error();
    return c;
  } catch { throw new Error('INVALID_CURSOR'); }
}

export type ScrollRepository<T> = {
  backend: string;
  scan: (after: string | null, exclude: string[]) => Promise<{ candidates: ScrollCandidate[]; after: string | null; more: boolean }>;
  signals: (candidates: ScrollCandidate[]) => Promise<ScrollSignals>;
  hydrate: (ids: string[]) => Promise<T[]>;
};
export async function personalizedScrollPage<T>(repo: ScrollRepository<T>, playerId: string, raw: string | null, refresh: ScrollRefresh = { seed: '', exclude: [] }) {
  let state = parseScrollCursor(raw, playerId, repo.backend);
  if (!state || (!state.pending.length && state.more)) {
    const seed = state?.seed ?? refresh.seed;
    let exclude = state?.exclude ?? refresh.exclude;
    let window = await repo.scan(state?.after ?? null, exclude);
    // A small/exhausted catalog can repeat rather than making refresh look broken.
    if (!state && exclude.length && !window.candidates.length && !window.more) {
      exclude = [];
      window = await repo.scan(null, exclude);
    }
    const signals = await repo.signals(window.candidates);
    state = { version: 1, playerId, backend: repo.backend, after: window.after, more: window.more, seed, exclude,
      pending: rankScrollCandidates(window.candidates, signals, playerId, Date.now(), seed).map(clip => clip.id) };
  }
  const ids = state.pending.slice(0, SCROLL_BATCH);
  state.pending = state.pending.slice(SCROLL_BATCH);
  return { videos: await repo.hydrate(ids), nextCursor: state.pending.length || state.more ? Buffer.from(JSON.stringify(state)).toString('base64url') : null };
}
