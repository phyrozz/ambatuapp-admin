import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../../../../../lib/player-auth';

export const runtime = 'nodejs';
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function POST(request: Request, { params }: { params: Promise<{ id: string; commentId: string }> }) {
  try {
    if (!adminDb) throw new Error('Lore service is not configured.');
    const player = await requirePlayer(request);
    const { id, commentId } = await params;
    const { value } = await request.json();
    if (![1, -1].includes(value)) throw new Error('Invalid vote.');
    const lore = adminDb.collection('lores').doc(id);
    const comment = lore.collection('comments').doc(commentId);
    const vote = comment.collection('votes').doc(player.id);
    const result = await adminDb.runTransaction(async transaction => {
      const [loreSnapshot, commentSnapshot, voteSnapshot] = await Promise.all([transaction.get(lore), transaction.get(comment), transaction.get(vote)]);
      if (loreSnapshot.data()?.status !== 'Published') throw new Error('Lore not found.');
      const commentData = commentSnapshot.data();
      if (!commentData) throw new Error('Comment not found.');
      const prior = voteSnapshot.data()?.value === 1 || voteSnapshot.data()?.value === -1 ? voteSnapshot.data()!.value : 0;
      const next = prior === value ? 0 : value;
      const upvotes = Math.max(0, (commentData.upvotes ?? 0) + (next === 1 ? 1 : 0) - (prior === 1 ? 1 : 0));
      const downvotes = Math.max(0, (commentData.downvotes ?? 0) + (next === -1 ? 1 : 0) - (prior === -1 ? 1 : 0));
      transaction.set(vote, { value: next, updatedAt: FieldValue.serverTimestamp() });
      transaction.update(comment, { upvotes, downvotes });
      return { value: next, upvotes, downvotes };
    });
    return NextResponse.json(result, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Vote failed.' }, { status: 401, headers });
  }
}
