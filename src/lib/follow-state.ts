import type { FriendState } from './friend-state';

export type FollowAction = 'follow' | 'unfollow' | 'accept';

/** Following and friendship are independent; only the request recipient can accept. */
export function followTransition(following: boolean, state: FriendState | null, action: FollowAction) {
  if (action === 'accept') {
    if (state !== 'incoming') throw new Error('INVALID_FRIEND_TRANSITION');
    return { following: true, state: 'accepted' as const, writeFriendship: true, notify: false };
  }
  if (action === 'unfollow') {
    return { following: false, state: state === 'outgoing' ? null : state, writeFriendship: state === 'outgoing', notify: false };
  }
  // A repeated Follow must not recreate a declined/cancelled request or spam notifications.
  const request = !following && !state;
  return { following: true, state: request ? 'outgoing' as const : state, writeFriendship: request, notify: request };
}

export function reciprocalFriendState(state: FriendState): FriendState {
  return state === 'accepted' ? 'accepted' : state === 'incoming' ? 'outgoing' : 'incoming';
}
