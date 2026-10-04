import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../lib/firebase-admin';
import { requireAdmin } from '../../../lib/api-auth';
import { adminErrorStatus } from '../../../lib/studio-api';
import { soundAudioUrl, soundColor, soundFields, soundResponse } from '../../../lib/admin-sounds';
import { adminSoundUploadKey, verifySoundUpload } from '../../../lib/s3-sounds';
import { isStudioRoot, studioContentOwner } from '../../../lib/studio-content';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const actor = await requireAdmin(request);
    if (!adminDb) return NextResponse.json({ error: 'Sound catalog is not configured.' }, { status: 503 });
    const snapshot = isStudioRoot(actor)
      ? await adminDb.collection('soundboardSounds').get()
      : await adminDb.collection('soundboardSounds').where('createdBy', '==', actor!.sub).get();
    const origin = new URL(request.url).origin;
    const sounds = snapshot.docs
      .map(doc => soundResponse(doc.id, doc.data(), soundAudioUrl(origin, doc.id)))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ sounds });
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
