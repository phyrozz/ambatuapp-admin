import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../../lib/firebase-admin';
import { playerFromRequest } from '../../../../../../lib/player-auth';
import { fallbackPlayerName, playerDisplayProfiles } from '../../../../../../lib/player-profiles';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!adminDb) return NextResponse.json({ error: 'Video service is not configured.' }, { status: 503, headers });
  const { id } = await params;
  const snapshot = await adminDb.collection('videos').doc(id).collection('comments').orderBy('createdAt', 'desc').limit(50).get();
  const anonymousId = new URL(request.url).searchParams.get('anonymousId');
  const voterId = anonymousId && anonymousId.length >= 12 && !anonymousId.includes('/') ? anonymousId : null;
  const profiles = await playerDisplayProfiles(
    snapshot.docs.map(doc => doc.data().authorId).filter((authorId, index): authorId is string => typeof authorId === 'string' && typeof snapshot.docs[index].data().authorEmail === 'string'),
    new Map(snapshot.docs.map(doc => [doc.data().authorId, doc.data().authorEmail ?? ''])),
  );
  const comments = await Promise.all(snapshot.docs.map(async doc => {
    const data = doc.data();
    const profile = typeof data.authorId === 'string' ? profiles.get(data.authorId) : undefined;
    const vote = voterId ? (await doc.ref.collection('votes').doc(voterId).get()).data()?.value ?? 0 : 0;
    return {
      id: doc.id,
      text: data.text,
      author: typeof data.authorEmail === 'string' ? profile?.username ?? data.author ?? fallbackPlayerName(data.authorEmail) : data.author ?? 'Anonymous',
      avatarUrl: profile?.avatarUrl ?? null,
      authorId: data.authorEmail ? data.authorId : null,
      parentId: typeof data.parentId === 'string' ? data.parentId : null,
      createdAt: data.createdAt?.toDate?.().toISOString() ?? null,
      upvotes: data.upvotes ?? 0,
      downvotes: data.downvotes ?? 0,
      userVote: vote,
    };
  }));
  return NextResponse.json({ comments }, { headers });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!adminDb) throw new Error('Video service is not configured.');
    const { id } = await params;
    const { text, anonymousId, parentId } = await request.json();
    if (typeof text !== 'string' || !text.trim() || text.length > 1000 || typeof anonymousId !== 'string' || anonymousId.length < 12 || anonymousId.includes('/')) throw new Error('Invalid comment.');
    if (parentId !== undefined && (typeof parentId !== 'string' || !parentId.trim())) throw new Error('Invalid reply target.');
    const player = await playerFromRequest(request);
    const video = adminDb.collection('videos').doc(id);
    const data = (await video.get()).data();
    if (!data || data.status !== 'Published') throw new Error('Video not found.');
    const commentsRef = video.collection('comments');
    if (typeof parentId === 'string' && !(await commentsRef.doc(parentId).get()).exists) throw new Error('Comment not found.');
    const profile = player ? (await playerDisplayProfiles([player.id], new Map([[player.id, player.email]]))).get(player.id) : undefined;
    const author = player ? profile?.username ?? fallbackPlayerName(player.email) : 'Anonymous';
    const cleanText = text.trim();
    const ref = await commentsRef.add({ text: cleanText, author, authorEmail: player?.email ?? null, authorId: player?.id ?? anonymousId, parentId: parentId ?? null, upvotes: 0, downvotes: 0, createdAt: FieldValue.serverTimestamp() });
    await video.update({ commentCount: FieldValue.increment(1) });
    return NextResponse.json({ id: ref.id, text: cleanText, author, avatarUrl: profile?.avatarUrl ?? null, authorId: player?.id ?? null, parentId: parentId ?? null, createdAt: new Date().toISOString(), upvotes: 0, downvotes: 0, userVote: 0 }, { status: 201, headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Comment failed.' }, { status: 400, headers });
  }
}
