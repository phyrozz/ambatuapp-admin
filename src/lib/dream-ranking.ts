export const DREAM_WINDOW = 48;
export const DREAM_BATCH = 8;
export type DreamCandidate = {
  id: string;
  author: string;
  publishedAt: number;
  audience: string;
  up: number;
  down: number;
  friend: boolean;
  vote: number;
};
export type DreamInterest = { author: string; value: number; at: number };
const clamp = (value: number, bound: number) =>
  Math.max(-bound, Math.min(bound, value));

/** Pure bounded ranking. Authorization happens before this function. */
export function rankDreams(
  candidates: DreamCandidate[],
  interests: DreamInterest[],
  viewer: string | null,
  now: number,
) {
  if (!viewer)
    return [...candidates].sort(
      (a, b) => b.publishedAt - a.publishedAt || b.id.localeCompare(a.id),
    );
  const affinity = new Map<string, number>();
  for (const signal of interests) {
    const decay = Math.pow(
      0.5,
      Math.max(0, now - signal.at) / (14 * 86400_000),
    );
    affinity.set(
      signal.author,
      (affinity.get(signal.author) ?? 0) + signal.value * decay,
    );
  }
  const pool = candidates.map((item) => {
    const fresh =
      3 / (1 + Math.max(0, now - item.publishedAt) / (7 * 86400_000));
    // Restricted engagement never supplies a cross-user popularity feature.
    const popular =
      item.audience === "public"
        ? clamp(Math.log1p(item.up) - Math.log1p(item.down), 2) * 0.4
        : 0;
    return {
      item,
      score:
        fresh +
        popular +
        (item.friend ? 2 : 0) +
        clamp(affinity.get(item.author) ?? 0, 3) +
        (item.author === viewer ? 0.5 : 0) +
        (item.vote === -1 ? -4 : item.vote === 1 ? -0.3 : 0),
      base: fresh + popular,
    };
  });
  const result: DreamCandidate[] = [];
  let counts = new Map<string, number>();
  while (pool.length) {
    if (result.length % DREAM_BATCH === 0) counts = new Map();
    const diversified = pool.filter(
      (row) => (counts.get(row.item.author) ?? 0) < 2,
    );
    let eligible = diversified.length ? diversified : pool;
    const discovery = result.length % 4 === 3;
    if (discovery) {
      const freshPublic = eligible.filter(
        (row) =>
          row.item.audience === "public" &&
          !row.item.friend &&
          row.item.author !== viewer,
      );
      if (freshPublic.length) eligible = freshPublic;
    }
    const score = (row: (typeof pool)[number]) =>
      (discovery ? row.base : row.score) -
      (result.at(-1)?.author === row.item.author ? 2 : 0);
    eligible.sort(
      (a, b) =>
        score(b) - score(a) ||
        b.item.publishedAt - a.item.publishedAt ||
        b.item.id.localeCompare(a.item.id),
    );
    const selected = eligible[0];
    pool.splice(pool.indexOf(selected), 1);
    result.push(selected.item);
    counts.set(
      selected.item.author,
      (counts.get(selected.item.author) ?? 0) + 1,
    );
  }
  return result;
}
