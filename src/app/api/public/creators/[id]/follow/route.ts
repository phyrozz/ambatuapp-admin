import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../../../lib/player-auth';
import { validFriendId } from '../../../../../../lib/friend-list';
import { creatorHeaders as headers, creatorProfile } from '../../../../../../lib/creator-profile';
import { followTransition, reciprocalFriendState, type FollowAction } from '../../../../../../lib/follow-state';
import type { FriendState } from '../../../../../../lib/friend-state';
import { playerDisplayProfiles } from '../../../../../../lib/player-profiles';
import { notifyFriendRequest } from '../../../../../../lib/friend-push';

export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let player;
  try { player = await requirePlayer(request); } catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  const { id } = await params;
  if (!validFriendId(id) || id === player.id || id === 'admin') return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400, headers });
  const db = adminDb;
  if (!db) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers });
  try {
    const { action } = await request.json();
    if (!['follow', 'unfollow', 'accept'].includes(action)) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400, headers });
    const viewer = db.collection('playerProfiles').doc(player.id);
    const target = db.collection('playerProfiles').doc(id);
    const following = viewer.collection('following').doc(id);
    const follower = target.collection('followers').doc(player.id);
    const ownFriend = viewer.collection('friends').doc(id);
    const otherFriend = target.collection('friends').doc(player.id);
    const result = await db.runTransaction(async tx => {
      const [targetProfile, currentFollow, currentFriend] = await Promise.all([tx.get(target), tx.get(following), tx.get(ownFriend)]);
      if (!targetProfile.exists) throw new Error('PLAYER_NOT_FOUND');
      const next = followTransition(currentFollow.exists, (currentFriend.data()?.state ?? null) as FriendState | null, action as FollowAction);
      if (next.following) {
        if (!currentFollow.exists) {
          const value = { createdAt: FieldValue.serverTimestamp() };
          tx.set(following, value);
          tx.set(follower, value);
        }
      } else { tx.delete(following); tx.delete(follower); }
      if (next.writeFriendship) {
        if (next.state) {
          tx.set(ownFriend, { state: next.state, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
          tx.set(otherFriend, { state: reciprocalFriendState(next.state), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        } else { tx.delete(ownFriend); tx.delete(otherFriend); }
      }
      return next;
    });
    if (result.notify) {
      try {
        const sender = (await playerDisplayProfiles([player.id], new Map([[player.id, player.email]]))).get(player.id);
        await notifyFriendRequest(id, sender?.username ?? player.email.split('@')[0]);
      } catch (error) { console.error('Friend request push unavailable:', error); }
    }
    return NextResponse.json(await creatorProfile(db, id, player.id), { headers });
  } catch (error) {
    const conflict = error instanceof Error && ['INVALID_FRIEND_TRANSITION', 'PLAYER_NOT_FOUND'].includes(error.message);
    return NextResponse.json({ error: conflict ? error.message : 'FOLLOW_UPDATE_FAILED' }, { status: conflict ? 409 : 400, headers });
  }
}
