import { FieldPath } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { isDevProfileWriter } from '../../../../../lib/dev-content-db';
import { searchProfiles } from '../../../../../lib/dev-profiles';
import { adminDb } from '../../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../../lib/player-auth';
import { playerDisplayProfiles } from '../../../../../lib/player-profiles';
import { validFriendId } from '../../../../../lib/friend-list';
import { creatorHeaders as headers } from '../../../../../lib/creator-profile';
import { normalizeCreatorQuery, creatorSearchMode, emailSearchKey } from '../../../../../lib/creator-search';

export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function GET(request: Request) {
  try { await requirePlayer(request); } catch { return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers }); }
  const db = adminDb;
  if (!db) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers });
  const params = new URL(request.url).searchParams;
  const q = normalizeCreatorQuery(params.get('q') ?? '');
  const mode = creatorSearchMode(q);
  if (!mode) return NextResponse.json({ players: [], nextCursor: null }, { headers });
  let cursor: { query: string; name: string; id: string } | null = null;
  const queryKey = mode === 'email' ? emailSearchKey(q) : q;
  if (params.get('cursor')) {
    try {
      const raw = params.get('cursor')!;
      if (raw.length > 1024) throw new Error();
      cursor = JSON.parse(Buffer.from(raw, 'base64url').toString());
      if (!cursor || cursor.query !== queryKey || !validFriendId(cursor.id) || typeof cursor.name !== 'string' || (mode === 'username' && !cursor.name.startsWith(q))) throw new Error();
    } catch { return NextResponse.json({ error: 'INVALID_CURSOR' }, { status: 400, headers }); }
  }
  try {
    if (isDevProfileWriter()) {
      const rows = await searchProfiles(mode, queryKey, cursor), page = rows.slice(0, 15), last = page.at(-1);
      const display = await playerDisplayProfiles(page.map(row => row.id), new Map());
      return NextResponse.json({ players: page.map(row => ({ id: row.id, ...display.get(row.id) })), nextCursor: rows.length > 15 && last ? Buffer.from(JSON.stringify({ query: queryKey, name: last.username_lower ?? '', id: last.id })).toString('base64url') : null }, { headers });
    }
    const profiles = db.collection('playerProfiles');
    let query = mode === 'email'
      ? profiles.where('emailSearchHash', '==', queryKey).orderBy(FieldPath.documentId()).limit(16)
      : profiles.where('usernameLower', '>=', q).where('usernameLower', '<=', `${q}\uf8ff`).orderBy('usernameLower').orderBy(FieldPath.documentId()).limit(16);
    if (cursor) query = mode === 'email' ? query.startAfter(cursor.id) : query.startAfter(cursor.name, cursor.id);
    const snapshot = await query.get();
    const page = snapshot.docs.slice(0, 15);
    const display = await playerDisplayProfiles(page.map(doc => doc.id), new Map());
    const last = page.at(-1);
    return NextResponse.json({
      players: page.map(doc => ({ id: doc.id, ...display.get(doc.id) })),
      nextCursor: snapshot.size > 15 && last ? Buffer.from(JSON.stringify({ query: queryKey, name: last.data().usernameLower ?? '', id: last.id })).toString('base64url') : null,
    }, { headers });
  } catch { return NextResponse.json({ error: 'SEARCH_FAILED' }, { status: 500, headers }); }
}
