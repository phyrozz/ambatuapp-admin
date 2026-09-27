import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../../lib/firebase-admin';
import { playerFromRequest, requirePlayer } from '../../../../../../lib/player-auth';
import { fallbackPlayerName, playerDisplayProfiles } from '../../../../../../lib/player-profiles';

export const runtime = 'nodejs';
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!adminDb) return NextResponse.json({ error: 'Lore service is not configured.' }, { status: 503, headers });
  const { id } = await params;
  const snapshot = await adminDb.collection('lores').doc(id).collection('comments').orderBy('createdAt', 'desc').limit(50).get();
  let playerId: string | null = null;
  if (request.headers.get('authorization')) {
    try { playerId = (await playerFromRequest(request))?.id ?? null; } catch {}
  }
  const profiles = await playerDisplayProfiles(
    snapshot.docs.map(doc => doc.data().authorId).filter((authorId): authorId is string => typeof authorId === 'string'),
    new Map(snapshot.docs.map(doc => [doc.data().authorId, doc.data().authorEmail ?? ''])),
  );
  const comments = await Promise.all(snapshot.docs.map(async doc => {
    const data = doc.data();
    const profile = typeof data.authorId === 'string' ? profiles.get(data.authorId) : undefined;
    const vote = playerId ? (await doc.ref.collection('votes').doc(playerId).get()).data()?.value ?? 0 : 0;
    return {
      id: doc.id,
      text: data.text,
      author: profile?.username ?? data.author ?? fallbackPlayerName(data.authorEmail ?? ''),
      avatarUrl: profile?.avatarUrl ?? null,
      authorId: data.authorId ?? null,
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
    if (!adminDb) throw new Error('Lore service is not configured.');
    const player = await requirePlayer(request);
    const { id } = await params;
    const { text, parentId } = await request.json();
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('Invalid comment.');
    if (parentId !== undefined && (typeof parentId !== 'string' || !parentId.trim())) throw new Error('Invalid reply target.');
    const lore = adminDb.collection('lores').doc(id);
    const data = (await lore.get()).data();
    if (!data || data.status !== 'Published') throw new Error('Lore not found.');
    const commentsRef = lore.collection('comments');
    if (typeof parentId === 'string' && !(await commentsRef.doc(parentId).get()).exists) throw new Error('Comment not found.');
    const profile = (await playerDisplayProfiles([player.id], new Map([[player.id, player.email]]))).get(player.id);
    const author = profile?.username ?? fallbackPlayerName(player.email);
    const cleanText = text.trim();
    const ref = await commentsRef.add({ text: cleanText, author, authorId: player.id, authorEmail: player.email, parentId: parentId ?? null, upvotes: 0, downvotes: 0, createdAt: FieldValue.serverTimestamp() });
    await lore.update({ commentCount: FieldValue.increment(1) });
    return NextResponse.json({ id: ref.id, text: cleanText, author, avatarUrl: profile?.avatarUrl ?? null, authorId: player.id, parentId: parentId ?? null, createdAt: new Date().toISOString(), upvotes: 0, downvotes: 0, userVote: 0 }, { status: 201, headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Comment failed.' }, { status: 401, headers });
  }
}
