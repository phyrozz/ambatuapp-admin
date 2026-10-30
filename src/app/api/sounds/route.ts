import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { isDevSoundWriter } from '../../../lib/dev-content-db';
import { createStudioSound, listStudioSounds } from '../../../lib/dev-sounds';
import { adminDb } from '../../../lib/firebase-admin';
import { requireAdmin } from '../../../lib/api-auth';
import { adminErrorStatus } from '../../../lib/studio-api';
import { soundAudioUrl, soundColor, soundFields, soundResponse } from '../../../lib/admin-sounds';
import { adminSoundUploadKey, verifySoundUpload } from '../../../lib/s3-sounds';
import { isStudioRoot, studioContentOwner } from '../../../lib/studio-content';
import { characterListFilter, encodeCharacterListCursor, parseCharacterListCursor } from '../../../lib/character-list-pagination';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const actor = await requireAdmin(request);
    if (!adminDb) return NextResponse.json({ error: 'Sound catalog is not configured.' }, { status: 503 });
    if (isDevSoundWriter()) return NextResponse.json(await listStudioSounds(actor, new URL(request.url)));
    const filter = characterListFilter(new URL(request.url), isStudioRoot(actor) ? null : actor!.sub);
    const cursor = parseCharacterListCursor(new URL(request.url).searchParams.get('cursor'), filter);
    let query = filter.owner ? adminDb.collection('soundboardSounds').where('createdBy', '==', filter.owner) : adminDb.collection('soundboardSounds');
    query = query.orderBy(FieldPath.documentId()).limit(filter.limit + 1);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    const page = snapshot.docs.slice(0, filter.limit), last = page.at(-1);
    const origin = new URL(request.url).origin;
    const sounds = page.map(doc => soundResponse(doc.id, doc.data(), soundAudioUrl(origin, doc.id)));
    return NextResponse.json({ sounds, nextCursor: snapshot.docs.length > filter.limit && last ? encodeCharacterListCursor(last.id, filter) : null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load sounds.' }, { status: adminErrorStatus(error, 401) });
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);
    if (!adminDb) return NextResponse.json({ error: 'Sound catalog is not configured.' }, { status: 503 });
    const body = await request.json() as Record<string, unknown>;
    const fields = soundFields(body);
    const soundKey = adminSoundUploadKey(body.soundKey, studioContentOwner(actor));
    await verifySoundUpload(soundKey);
    if (isDevSoundWriter()) return NextResponse.json(await createStudioSound(actor, fields, soundKey, body.color, new URL(request.url).origin), { status: 201 });
    const collection = adminDb.collection('soundboardSounds');
    const existing = await collection.get();
    const color = soundColor(body.color, existing.size);
    const ref = collection.doc(crypto.randomUUID());
    const record = { ...fields, color, soundKey, ...(actor ? { createdBy: actor.sub } : {}), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
    await ref.set(record);
    const origin = new URL(request.url).origin;
    return NextResponse.json(soundResponse(ref.id, { ...record, createdAt: null }, soundAudioUrl(origin, ref.id)), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not add sound.' }, { status: adminErrorStatus(error, 400) });
  }
}
