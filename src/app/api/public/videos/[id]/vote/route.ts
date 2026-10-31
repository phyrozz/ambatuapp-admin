import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { isDevVideoWriter } from '../../../../../../lib/dev-content-db';
import { voteVideo } from '../../../../../../lib/dev-video-interactions';
import { adminDb } from '../../../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../../../lib/player-auth';
import { allowPlayerWrite } from '../../../../../../lib/public-write-limits';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let player: Awaited<ReturnType<typeof requirePlayer>>;
  try {
    player = await requirePlayer(request);
  } catch {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers });
  }

  try {
    if (!adminDb && !isDevVideoWriter()) throw new Error('Video service is not configured.');
    const { id } = await params;
    const { value } = await request.json();
    if (![1, -1].includes(value)) throw new Error('Invalid vote.');
    if (!await allowPlayerWrite(adminDb, player.id, 'videoVotes', [{ key: 'minute', max: 30, windowMs: 60_000 }])) {
      return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429, headers });
    }
    if (isDevVideoWriter()) return NextResponse.json(await voteVideo(id, player.id, value), { headers });
    const video = adminDb!.collection('videos').doc(id);
    const vote = video.collection('votes').doc(`user:${player.id}`);
    const next = await adminDb!.runTransaction(async transaction => {
      const [videoSnapshot, voteSnapshot] = await Promise.all([transaction.get(video), transaction.get(vote)]);
      const data = videoSnapshot.data();
      if (!data || data.status !== 'Published') throw new Error('Video not found.');
      const prior = voteSnapshot.data()?.value ?? 0;
      const result = prior === value ? 0 : value;
      transaction.set(vote, { value: result, updatedAt: FieldValue.serverTimestamp() });
      transaction.update(video, { upvotes: Math.max(0, (data.upvotes ?? 0) + (result === 1 ? 1 : 0) - (prior === 1 ? 1 : 0)), downvotes: Math.max(0, (data.downvotes ?? 0) + (result === -1 ? 1 : 0) - (prior === -1 ? 1 : 0)) });
      return { value: result, upvotes: Math.max(0, (data.upvotes ?? 0) + (result === 1 ? 1 : 0) - (prior === 1 ? 1 : 0)), downvotes: Math.max(0, (data.downvotes ?? 0) + (result === -1 ? 1 : 0) - (prior === -1 ? 1 : 0)) };
    });
    return NextResponse.json(next, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Vote failed.' }, { status: 400, headers });
  }
}
