export type FriendState = 'incoming' | 'outgoing' | 'accepted';
export type FriendAction = 'request' | 'accept' | 'remove';

/** Both sides are written in one transaction; only the recipient can accept. */
export function friendTransition(state: FriendState | undefined, action: FriendAction): [FriendState, FriendState] | null {
  if (action === 'remove') return null;
  if (action === 'accept') {
    if (state !== 'incoming') throw new Error('INVALID_FRIEND_TRANSITION');
    return ['accepted', 'accepted'];
  }
  if (state === 'accepted') return ['accepted', 'accepted'];
  if (state === 'incoming') throw new Error('INVALID_FRIEND_TRANSITION');
  return ['outgoing', 'incoming'];
}
