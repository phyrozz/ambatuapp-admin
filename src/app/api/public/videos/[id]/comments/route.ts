import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../../lib/firebase-admin';
import { playerFromRequest } from '../../../../../../lib/player-auth';
import { fallbackPlayerName, playerNames } from '../../../../../../lib/player-profiles';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!adminDb) return NextResponse.json({ error: 'Video service is not configured.' }, { status: 503, headers });
  const { id } = await params;
  const snapshot = await adminDb.collection('videos').doc(id).collection('comments').orderBy('createdAt', 'desc').limit(50).get();
  const names = await playerNames(snapshot.docs.map((doc) => doc.data().authorId).filter((id, index): id is string => typeof id === 'string' && typeof snapshot.docs[index].data().authorEmail === 'string'), new Map(snapshot.docs.map((doc) => [doc.data().authorId, doc.data().authorEmail ?? ''])));
  return NextResponse.json({ comments: snapshot.docs.map(doc => { const data = doc.data(); return { id: doc.id, text: data.text, author: typeof data.authorEmail === 'string' ? names.get(data.authorId) ?? data.author ?? fallbackPlayerName(data.authorEmail) : data.author ?? 'Anonymous', createdAt: data.createdAt?.toDate?.().toISOString() ?? null }; }) }, { headers });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!adminDb) throw new Error('Video service is not configured.');
    const { id } = await params;
    const { text, anonymousId } = await request.json();
    if (typeof text !== 'string' || !text.trim() || text.length > 1000 || typeof anonymousId !== 'string' || anonymousId.length < 12) throw new Error('Invalid comment.');
    const player = await playerFromRequest(request);
    const video = adminDb.collection('videos').doc(id);
    const data = (await video.get()).data();
    if (!data || data.status !== 'Published') throw new Error('Video not found.');
    const author = player ? (await playerNames([player.id], new Map([[player.id, player.email]]))).get(player.id) ?? fallbackPlayerName(player.email) : 'Anonymous';
    const ref = await video.collection('comments').add({ text: text.trim(), author, authorEmail: player?.email ?? null, authorId: player?.id ?? anonymousId, createdAt: FieldValue.serverTimestamp() });
    await video.update({ commentCount: FieldValue.increment(1) });
    return NextResponse.json({ id: ref.id, text: text.trim(), author, createdAt: new Date().toISOString() }, { status: 201, headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Comment failed.' }, { status: 400, headers });
  }
}
