import { NextResponse } from 'next/server';
import { isDevCharacterWriter } from '../../../lib/dev-content-db';
import { createStudioCharacter, listStudioCharacters } from '../../../lib/dev-characters';
import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '../../../lib/firebase-admin';
import { requireAdmin } from '../../../lib/api-auth';
import { adminErrorStatus } from '../../../lib/studio-api';
import { characterImageKey, signedCharacterImageUrl } from '../../../lib/s3-images';
import { isStudioRoot } from '../../../lib/studio-content';
import { characterListFilter, encodeCharacterListCursor, parseCharacterListCursor } from '../../../lib/character-list-pagination';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const actor = await requireAdmin(request);
    if (isDevCharacterWriter()) return NextResponse.json(await listStudioCharacters(actor, new URL(request.url)));
    if (!adminDb && !isDevCharacterWriter()) return NextResponse.json({ configured: false, characters: [] });
    const filter = characterListFilter(new URL(request.url), isStudioRoot(actor) ? null : actor!.sub);
    let after = parseCharacterListCursor(new URL(request.url).searchParams.get('cursor'), filter);
    const matches: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    while (matches.length <= filter.limit) {
      let query: FirebaseFirestore.Query = adminDb!.collection('characters');
      if (filter.owner) query = query.where('createdBy', '==', filter.owner);
      query = query.orderBy(FieldPath.documentId()).limit(filter.limit + 1);
      if (after) query = query.startAfter(after);
      const snapshot = await query.get();
      if (!snapshot.docs.length) break;
      for (const doc of snapshot.docs) {
        after = doc.id;
        const data = doc.data();
        const text = [data.name, data.title, ...(Array.isArray(data.tags) ? data.tags : [])].join(' ').toLowerCase();
        if ((filter.status && data.status !== filter.status) || (filter.query && !text.includes(filter.query))) continue;
        matches.push(doc);
        if (matches.length > filter.limit) break;
      }
      if (matches.length > filter.limit || snapshot.docs.length < filter.limit + 1) break;
    }
    const page = matches.slice(0, filter.limit), last = page.at(-1);
    const characters = await Promise.all(page.map(async doc => { const { createdBy: _createdBy, ...data } = doc.data(); const imageKey = characterImageKey(data.imageKey, data.image); return { id: doc.id, ...data, imageKey, imageUrl: await signedCharacterImageUrl(imageKey), updated: data.updated ?? 'Recently' }; }));
    return NextResponse.json({ configured: true, characters, nextCursor: matches.length > filter.limit && last ? encodeCharacterListCursor(last.id, filter) : null });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Unauthorized' }, { status: adminErrorStatus(error, error instanceof Error && error.message === 'studio.errors.request' ? 400 : 401) }); }
}
export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);
    if (!adminDb && !isDevCharacterWriter()) return NextResponse.json({ error: 'Firestore is not configured.' }, { status: 503 });
    const body = await request.json();
    if (isDevCharacterWriter()) return NextResponse.json(await createStudioCharacter(actor, body), { status: 201 });
    const imageKey = typeof body.imageKey === 'string' ? body.imageKey : null;
    if (actor && actor.roleId !== 'root' && imageKey && !imageKey.startsWith(`characters/${actor.sub}/`)) throw new Error('studio.errors.forbidden');
    const stored = { name: body.name, title: body.title, bio: body.bio ?? '', status: body.status ?? 'Draft', tags: body.tags ?? [], imageKey, ...(actor ? { createdBy: actor.sub } : {}), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), updated: 'Just now' };
    const ref = await adminDb!.collection('characters').add(stored);
    const { createdBy: _createdBy, ...visible } = stored;
    return NextResponse.json({ id: ref.id, ...visible, createdAt: null, updatedAt: null, imageUrl: await signedCharacterImageUrl(imageKey ?? undefined), updated: 'Just now' }, { status: 201 });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status: adminErrorStatus(error, 400) }); }
}
