import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../../../../lib/firebase-admin';
import { playerFromRequest } from '../../../../../../../../lib/player-auth';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function POST(request: Request, { params }: { params: Promise<{ id: string; commentId: string }> }) {
  try {
    if (!adminDb) throw new Error('Video service is not configured.');
    const { id, commentId } = await params;
    const { anonymousId, value } = await request.json();
    const player = await playerFromRequest(request);
    if ((!player && (typeof anonymousId !== 'string' || anonymousId.length < 12 || anonymousId.includes('/'))) || ![1, -1].includes(value)) throw new Error('Invalid vote.');
    const video = adminDb.collection('videos').doc(id);
    const comment = video.collection('comments').doc(commentId);
    const vote = comment.collection('votes').doc(player ? `user:${player.id}` : anonymousId);
    const result = await adminDb.runTransaction(async transaction => {
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
