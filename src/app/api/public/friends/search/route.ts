import { FieldPath } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../../lib/player-auth';
import { playerDisplayProfiles } from '../../../../../lib/player-profiles';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }
export async function GET(request: Request) {
  let player;
  try { player = await requirePlayer(request); } catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  const db = adminDb;
  if (!db) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers });
  const params = new URL(request.url).searchParams;
  const q = (params.get('q') ?? '').normalize('NFKC').trim().toLocaleLowerCase();
  if (q.length < 2 || q.length > 24) return NextResponse.json({ friends: [], nextCursor: null }, { headers });
  let cursor: { q: string; name: string; id: string } | null = null;
  if (params.get('cursor')) {
    try {
      const raw = params.get('cursor')!;
      if (raw.length > 1024) throw new Error();
      cursor = JSON.parse(Buffer.from(raw, 'base64url').toString());
      if (!cursor || cursor.q !== q || typeof cursor.name !== 'string' || !cursor.name.startsWith(q) || typeof cursor.id !== 'string' || !/^[\w-]{1,128}$/.test(cursor.id)) throw new Error();
    } catch { return NextResponse.json({ error: 'INVALID_CURSOR' }, { status: 400, headers }); }
  }
  try {
    let query = db.collection('playerProfiles').where('usernameLower', '>=', q).where('usernameLower', '<=', `${q}\uf8ff`).orderBy('usernameLower').orderBy(FieldPath.documentId()).limit(16);
    if (cursor) query = query.startAfter(cursor.name, cursor.id);
    const snapshot = await query.get();
    const page = snapshot.docs.slice(0, 15);
    const ids = page.filter(doc => doc.id !== player.id).map(doc => doc.id);
    const profiles = await playerDisplayProfiles(ids, new Map());
    const friends = await Promise.all(ids.map(async id => ({ id, ...profiles.get(id), state: (await db.collection('playerProfiles').doc(player.id).collection('friends').doc(id).get()).data()?.state ?? null })));
    const last = page.at(-1);
    return NextResponse.json({ friends, nextCursor: snapshot.size > 15 && last ? Buffer.from(JSON.stringify({ q, name: last.data().usernameLower, id: last.id })).toString('base64url') : null }, { headers });
  } catch { return NextResponse.json({ error: 'SEARCH_FAILED' }, { status: 500, headers }); }
}
