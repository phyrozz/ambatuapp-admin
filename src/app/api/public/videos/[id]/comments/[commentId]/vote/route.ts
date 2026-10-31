import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { isDevVideoWriter } from '../../../../../../../../lib/dev-content-db';
import { voteVideo } from '../../../../../../../../lib/dev-video-interactions';
import { adminDb } from '../../../../../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../../../../../lib/player-auth';
import { allowPlayerWrite } from '../../../../../../../../lib/public-write-limits';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function POST(request: Request, { params }: { params: Promise<{ id: string; commentId: string }> }) {
  let player: Awaited<ReturnType<typeof requirePlayer>>;
  try {
    player = await requirePlayer(request);
  } catch {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers });
  }

  try {
    if (!adminDb && !isDevVideoWriter()) throw new Error('Video service is not configured.');
    const { id, commentId } = await params;
    const { value } = await request.json();
    if (![1, -1].includes(value)) throw new Error('Invalid vote.');
    if (!await allowPlayerWrite(adminDb, player.id, 'videoVotes', [{ key: 'minute', max: 30, windowMs: 60_000 }])) {
      return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429, headers });
    }
    if (isDevVideoWriter()) return NextResponse.json(await voteVideo(id, player.id, value, commentId), { headers });
    const video = adminDb!.collection('videos').doc(id);
    const comment = video.collection('comments').doc(commentId);
    const vote = comment.collection('votes').doc(`user:${player.id}`);
    const result = await adminDb!.runTransaction(async transaction => {
      const [videoSnapshot, commentSnapshot, voteSnapshot] = await Promise.all([transaction.get(video), transaction.get(comment), transaction.get(vote)]);
      if (videoSnapshot.data()?.status !== 'Published') throw new Error('Video not found.');
      const commentData = commentSnapshot.data();
      if (!commentData) throw new Error('Comment not found.');
      const storedVote = voteSnapshot.data()?.value;
      const prior = storedVote === 1 || storedVote === -1 ? storedVote : 0;
      const next = prior === value ? 0 : value;
      const upvotes = Math.max(0, (commentData.upvotes ?? 0) + (next === 1 ? 1 : 0) - (prior === 1 ? 1 : 0));
      const downvotes = Math.max(0, (commentData.downvotes ?? 0) + (next === -1 ? 1 : 0) - (prior === -1 ? 1 : 0));
      transaction.set(vote, { value: next, updatedAt: FieldValue.serverTimestamp() });
      transaction.update(comment, { upvotes, downvotes });
      return { value: next, upvotes, downvotes };
    });
    return NextResponse.json(result, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Vote failed.' }, { status: 400, headers });
  }
}
