import type { FriendState } from './friend-state';

export const validFriendId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,128}$/.test(id);
export type FriendFilter = { state: FriendState | null; pinned: boolean };

export function friendFilter(params: URLSearchParams): FriendFilter {
  const state = params.get('state');
  const pinned = params.get('pinned');
  if ((state && !['accepted', 'incoming', 'outgoing'].includes(state)) || (pinned && pinned !== 'true') || (pinned && state && state !== 'accepted')) throw new Error('INVALID_FILTER');
  return { state: (state || null) as FriendState | null, pinned: pinned === 'true' };
}

/** New cursors are tied to the list filter; old unfiltered clients can keep using document IDs. */
export function friendCursor(raw: string | null, filter: FriendFilter): string | null {
  if (!raw) return null;
  if (!filter.state && !filter.pinned && validFriendId(raw)) return raw;
  if (raw.length > 1024) throw new Error('INVALID_CURSOR');
  try {
    const cursor = JSON.parse(Buffer.from(raw.replace(/^v1\./, ''), 'base64url').toString());
    if (!validFriendId(cursor.id) || cursor.state !== filter.state || cursor.pinned !== filter.pinned) throw new Error();
    return cursor.id;
  } catch { throw new Error('INVALID_CURSOR'); }
}

export function nextFriendCursor(id: string, filter: FriendFilter) {
  return !filter.state && !filter.pinned ? id : `v1.${Buffer.from(JSON.stringify({ id, ...filter })).toString('base64url')}`;
}

export function matchesFriendFilter(data: { state?: string; pinned?: boolean }, filter: FriendFilter) {
  return (!filter.state || data.state === filter.state) && (!filter.pinned || (data.state === 'accepted' && data.pinned === true));
}
