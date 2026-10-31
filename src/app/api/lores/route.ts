import { NextResponse } from 'next/server';
import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '../../../lib/firebase-admin';
import { requireAdmin } from '../../../lib/api-auth';
import { adminErrorStatus } from '../../../lib/studio-api';
import { signedCharacterImageUrl } from '../../../lib/s3-images';
import { LORE_TEXT_LIMIT, validateLoreTranslations } from '../../../lib/lore';
import { isStudioRoot } from '../../../lib/studio-content';
import { characterListFilter, encodeCharacterListCursor, parseCharacterListCursor } from '../../../lib/character-list-pagination';
import { isDevLoreWriter } from '../../../lib/dev-content-db';
import { createStudioLore, listStudioLores } from '../../../lib/dev-lores';

export const runtime = 'nodejs';
async function hydrate(id: string, data: Record<string, unknown>) {
  const { createdBy: _createdBy, ...visible } = data;
  const keys = Array.isArray(visible.imageKeys) ? visible.imageKeys.filter((key): key is string => typeof key === 'string') : [];
  return { id, ...visible, imageKeys: keys, imageUrls: await Promise.all(keys.map(signedCharacterImageUrl)), updated: visible.updated ?? 'Recently' };
}
export async function GET(request: Request) {
  try {
    const actor = await requireAdmin(request);
    if (!adminDb && !isDevLoreWriter()) return NextResponse.json({ configured: false, lores: [] });
    const url = new URL(request.url);
    if (isDevLoreWriter()) return NextResponse.json(await listStudioLores(actor, url));
    const filter = characterListFilter(url, isStudioRoot(actor) ? null : actor!.sub);
    let after = parseCharacterListCursor(url.searchParams.get('cursor'), filter);
    const matches: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    while (matches.length <= filter.limit) {
      let query: FirebaseFirestore.Query = adminDb!.collection('lores');
      if (filter.owner) query = query.where('createdBy', '==', filter.owner);
      query = query.orderBy(FieldPath.documentId()).limit(filter.limit + 1);
      if (after) query = query.startAfter(after);
      const snapshot = await query.get();
      if (!snapshot.docs.length) break;
      for (const doc of snapshot.docs) {
        after = doc.id;
        const data = doc.data();
        const text = [data.title, data.text, ...(Array.isArray(data.tags) ? data.tags : [])].join(' ').toLowerCase();
        if ((filter.status && data.status !== filter.status) || (filter.query && !text.includes(filter.query))) continue;
        matches.push(doc);
        if (matches.length > filter.limit) break;
      }
      if (matches.length > filter.limit || snapshot.docs.length < filter.limit + 1) break;
    }
    const page = matches.slice(0, filter.limit), last = page.at(-1);
    return NextResponse.json({ configured: true, lores: await Promise.all(page.map(doc => hydrate(doc.id, doc.data()))),
      nextCursor: matches.length > filter.limit && last ? encodeCharacterListCursor(last.id, filter) : null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unauthorized' }, { status: adminErrorStatus(error, error instanceof Error && error.message === 'studio.errors.request' ? 400 : 401) });
  }
}
export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);
    if (!adminDb && !isDevLoreWriter()) return NextResponse.json({ error: 'Firestore is not configured.' }, { status: 503 });
    const body = await request.json();
    if (typeof body.text !== 'string' || !body.text.trim()) throw new Error('Lore text is required.');
    if (body.text.length > LORE_TEXT_LIMIT) throw new Error(`Lore text cannot exceed ${LORE_TEXT_LIMIT.toLocaleString()} characters.`);
    validateLoreTranslations(body.translations);
    if (isDevLoreWriter()) return NextResponse.json(await createStudioLore(actor, body), { status: 201 });
    const imageKeys = Array.isArray(body.imageKeys) ? body.imageKeys : [];
    if (actor && actor.roleId !== 'root' && imageKeys.some((key: unknown) => typeof key !== 'string' || !key.startsWith(`lores/${actor.sub}/`))) throw new Error('studio.errors.forbidden');
    const stored = { title: body.title, text: body.text, translations: body.translations ?? [], tags: body.tags ?? [], imageKeys, status: body.status ?? 'Draft', upvotes: 0, downvotes: 0, commentCount: 0, ...(actor ? { createdBy: actor.sub } : {}), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), updated: 'Just now' };
    const ref = await adminDb!.collection('lores').add(stored);
    return NextResponse.json(await hydrate(ref.id, { ...stored, createdAt: null, updatedAt: null }), { status: 201 });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status: adminErrorStatus(error, 400) }); }
}
