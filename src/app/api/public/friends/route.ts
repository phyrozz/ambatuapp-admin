import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../lib/player-auth';
import { playerDisplayProfiles } from '../../../../lib/player-profiles';
import { friendTransition, type FriendState } from '../../../../lib/friend-state';
import { notifyFriendRequest } from '../../../../lib/friend-push';
import { friendFilter, friendCursor, nextFriendCursor, matchesFriendFilter, validFriendId, type FriendFilter } from '../../../../lib/friend-list';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function GET(request: Request) {
  let player;
  try { player = await requirePlayer(request); } catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  if (!adminDb) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers });
  let filter: FriendFilter, cursor: string | null;
  try {
    const params = new URL(request.url).searchParams;
    filter = friendFilter(params); cursor = friendCursor(params.get('cursor'), filter);
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'INVALID_REQUEST' }, { status: 400, headers }); }
  try {
    let query = adminDb.collection('playerProfiles').doc(player.id).collection('friends').orderBy(FieldPath.documentId()).limit(21);
    if (filter.pinned) query = query.where('pinned', '==', true);
    else if (filter.state) query = query.where('state', '==', filter.state);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    const page = snapshot.docs.slice(0, 20);
    const visible = page.filter(doc => matchesFriendFilter(doc.data(), filter));
    const profiles = await playerDisplayProfiles(visible.map(doc => doc.id), new Map());
    return NextResponse.json({ friends: visible.map(doc => ({ id: doc.id, ...profiles.get(doc.id), state: doc.data().state, pinned: doc.data().pinned === true })), nextCursor: snapshot.size > 20 ? nextFriendCursor(page.at(-1)!.id, filter) : null }, { headers });
  } catch { return NextResponse.json({ error: 'FRIENDS_UNAVAILABLE' }, { status: 500, headers }); }
}

export async function POST(request: Request) {
  let player;
  try { player = await requirePlayer(request); } catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  const db = adminDb;
  if (!db) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers });
  try {
    const { targetId, action } = await request.json();
    if (!validFriendId(targetId) || targetId === player.id || !['request', 'accept', 'remove', 'pin', 'unpin'].includes(action)) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400, headers });
    const own = db.collection('playerProfiles').doc(player.id).collection('friends').doc(targetId);
    const other = db.collection('playerProfiles').doc(targetId).collection('friends').doc(player.id);
    const result = await db.runTransaction(async tx => {
      const [current, target] = await Promise.all([tx.get(own), tx.get(db.collection('playerProfiles').doc(targetId))]);
      if (!target.exists && action !== 'remove') throw new Error('PLAYER_NOT_FOUND');
      if (action === 'pin' || action === 'unpin') {
        if (current.data()?.state !== 'accepted') throw new Error('INVALID_FRIEND_TRANSITION');
        tx.update(own, { pinned: action === 'pin' });
        return { state: 'accepted', pinned: action === 'pin', notify: false };
      }
      const next = friendTransition(current.data()?.state as FriendState | undefined, action);
      if (!next) { tx.delete(own); tx.delete(other); return { state: null, pinned: false, notify: false }; }
      tx.set(own, { state: next[0], updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.set(other, { state: next[1], updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return { state: next[0], pinned: current.data()?.pinned === true, notify: action === 'request' && !current.exists };
    });
    if (result.notify) {
      try {
        const sender = (await playerDisplayProfiles([player.id], new Map([[player.id, player.email]]))).get(player.id);
        await notifyFriendRequest(targetId, sender?.username ?? player.email.split('@')[0]);
      }
      catch (error) { console.error('Friend request push unavailable:', error); }
    }
    return NextResponse.json({ state: result.state, pinned: result.pinned }, { headers });
  } catch (error) {
    const conflict = error instanceof Error && ['INVALID_FRIEND_TRANSITION', 'PLAYER_NOT_FOUND'].includes(error.message);
    return NextResponse.json({ error: conflict ? error.message : 'FRIEND_UPDATE_FAILED' }, { status: conflict ? 409 : 400, headers });
  }
}
