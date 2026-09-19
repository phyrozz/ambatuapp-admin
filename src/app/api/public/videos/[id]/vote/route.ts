import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../../lib/firebase-admin';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!adminDb) throw new Error('Video service is not configured.');
    const { id } = await params;
    const { anonymousId, value } = await request.json();
    if (typeof anonymousId !== 'string' || anonymousId.length < 12 || ![1, -1].includes(value)) throw new Error('Invalid vote.');
    const video = adminDb.collection('videos').doc(id);
    const vote = video.collection('votes').doc(anonymousId);
    const next = await adminDb.runTransaction(async transaction => {
      const [videoSnapshot, voteSnapshot] = await Promise.all([transaction.get(video), transaction.get(vote)]);
      const data = videoSnapshot.data();
      if (!data || data.status !== 'Published') throw new Error('Video not found.');
      const prior = voteSnapshot.data()?.value ?? 0;
      const result = prior === value ? 0 : value;
      transaction.set(vote, { value: result, updatedAt: FieldValue.serverTimestamp() });
      transaction.update(video, { upvotes: Math.max(0, (data.upvotes ?? 0) + (result === 1 ? 1 : 0) - (prior === 1 ? 1 : 0)), downvotes: Math.max(0, (data.downvotes ?? 0) + (result === -1 ? 1 : 0) - (prior === -1 ? 1 : 0)) });
      return result;
    });
    return NextResponse.json({ value: next }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Vote failed.' }, { status: 400, headers });
  }
}
