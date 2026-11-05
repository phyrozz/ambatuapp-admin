import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeScrollHistory, parseScrollCursor, parseWatchSignal, personalizedScrollPage, rankScrollCandidates, recentHistory, scrollTopics } from './scroll-ranking.ts';

const now = Date.now();
const clip = (id, creator = id) => ({ id, creator, title: 'A clip', description: '', createdAt: now, upvotes: 0, downvotes: 0, vote: 0 });
const history = (id, creator, watchedMs = 10000) => ({ id, creator, topics: [], watchedMs, durationMs: 10000, at: now });
const signals = (items = [], following = [], votes = []) => ({ history: items, following: new Set(following), votes: new Map(votes) });

test('different accounts learn different creators; follows and votes seed existing accounts', () => {
  const clips = [clip('a', 'alice'), clip('b', 'bob')];
  assert.equal(rankScrollCandidates(clips, signals([history('old-a', 'alice')]), 'one', now)[0].id, 'a');
  assert.equal(rankScrollCandidates(clips, signals([history('old-b', 'bob')]), 'two', now)[0].id, 'b');
  assert.equal(rankScrollCandidates(clips, signals([], ['bob']), 'one', now)[0].id, 'b');
  assert.equal(rankScrollCandidates(clips, signals([history('old-b', 'bob', 600)], [], [['old-b', 1]]), 'one', now)[0].id, 'b');
  assert.equal(rankScrollCandidates(clips, signals([history('old-a', 'alice')], [], [['old-a', -1]]), 'one', now)[0].id, 'b');
});

test('skips, seen clips, downvotes and topic preferences affect ranking', () => {
  assert.equal(rankScrollCandidates([clip('a', 'alice'), clip('b', 'bob')], signals([history('old-a', 'alice', 500)]), 'one', now)[0].id, 'b');
  assert.equal(rankScrollCandidates([clip('a'), clip('b')], signals([history('a', 'a')]), 'one', now)[0].id, 'b');
  assert.equal(rankScrollCandidates([{ ...clip('a'), vote: -1 }, clip('b')], signals(), 'one', now)[0].id, 'b');
  const topicHistory = { ...history('old', null), topics: ['cats'] };
  const ranked = rankScrollCandidates([{ ...clip('a'), title: 'Cats' }, { ...clip('b'), title: 'Cars' }], signals([topicHistory]), 'one', now);
  assert.equal(ranked[0].id, 'a');
  assert.deepEqual(scrollTopics('Kucing lucu yang ini', '#Kucing #lucu #kucing'), ['kucing', 'lucu']);
});

test('exploration and creator diversity leave room for discovery', () => {
  const clips = [...Array.from({ length: 8 }, (_, i) => clip(`a${i}`, 'alice')), ...Array.from({ length: 8 }, (_, i) => clip(`b${i}`, `new${i}`))];
  const result = rankScrollCandidates(clips, signals([history('x', 'alice'), history('y', 'alice')], ['alice']), 'one', now);
  assert.equal(result[0].creator, 'alice');
  assert.notEqual(result[3].creator, 'alice');
  assert.equal(new Set(result.map(item => item.id)).size, clips.length);
  assert.deepEqual(rankScrollCandidates(clips, signals(), 'new-user', now), rankScrollCandidates(clips, signals(), 'new-user', now));
});

test('watch history is bounded, pruned and retry-safe; expired interests do not affect ranking', () => {
  const items = Array.from({ length: 110 }, (_, i) => ({ ...history(`old${i}`, 'creator'), at: now - i }));
  const first = mergeScrollHistory(items, clip('new'), { watchedMs: 9000, durationMs: 10000 }, now);
  assert.equal(first.length, 100);
  const retry = mergeScrollHistory(first, clip('new'), { watchedMs: 500, durationMs: 10000 }, now);
  assert.deepEqual(retry, first);
  assert.deepEqual(recentHistory([{ ...history('expired', 'a'), at: now - 91 * 86400000 }], now), []);
  assert.throws(() => parseWatchSignal({ watchedMs: 120001, durationMs: 10000 }), /INVALID_SIGNAL/);
  for (const value of [null, {}, { watchedMs: '2000', durationMs: 10 }, { watchedMs: 2000, durationMs: 0 }, { watchedMs: -1, durationMs: 10000 }]) assert.throws(() => parseWatchSignal(value));
  assert.deepEqual(parseWatchSignal({ watchedMs: 500, durationMs: 10000, playerId: 'ignored' }), { watchedMs: 500, durationMs: 10000 });
});

test('cursor queue preserves all ranked items despite changing preferences, deletion and inserts', async () => {
  const clips = Array.from({ length: 53 }, (_, i) => clip(`c${i}`, `creator${i % 4}`));
  let scans = 0, reads = 0;
  const unavailable = new Set();
  const repo = { backend: 'postgres', scan: async after => {
    scans++;
    const start = after ? Number(after) : 0;
    return { candidates: clips.slice(start, start + 24), after: String(start + 24), more: start + 24 < clips.length };
  }, signals: async () => { reads++; return signals([], [reads % 2 ? 'creator1' : 'creator2']); },
  hydrate: async ids => ids.filter(id => !unavailable.has(id)) };
  const first = await personalizedScrollPage(repo, 'one', null);
  assert.equal(first.videos.length, 8);
  const state = parseScrollCursor(first.nextCursor, 'one', 'postgres');
  const expectedSecond = state.pending.slice(0, 8);
  unavailable.add(expectedSecond[0]);
  const second = await personalizedScrollPage(repo, 'one', first.nextCursor);
  assert.deepEqual(second.videos, expectedSecond.slice(1));
  assert.equal(scans, 1);
  assert.equal(reads, 1);
  const all = [...first.videos, ...second.videos];
  let cursor = second.nextCursor;
  while (cursor) {
    const page = await personalizedScrollPage(repo, 'one', cursor);
    assert(page.videos.length <= 8);
    all.push(...page.videos);
    cursor = page.nextCursor;
  }
  assert.equal(scans, 3);
  assert.equal(all.length, 52);
  assert.equal(new Set(all).size, 52);
  assert.throws(() => parseScrollCursor(first.nextCursor, 'two', 'postgres'), /INVALID_CURSOR/);
  for (const bad of ['broken', 'x'.repeat(8193), Buffer.from(JSON.stringify({ ...state, pending: ['a', 'a'] })).toString('base64url')]) {
    assert.throws(() => parseScrollCursor(bad, 'one', 'postgres'), /INVALID_CURSOR/);
  }
});

test('empty and wholly unpublished remaining pages terminate without looping', async () => {
  const result = await personalizedScrollPage({ backend: 'postgres', scan: async () => ({ candidates: [], after: null, more: false }), signals: async () => signals(), hydrate: async () => [] }, 'one', null);
  assert.deepEqual(result, { videos: [], nextCursor: null });
});
