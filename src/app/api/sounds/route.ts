import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../lib/firebase-admin';
import { requireAdmin } from '../../../lib/api-auth';
import { soundAudioUrl, soundColor, soundFields, soundResponse } from '../../../lib/admin-sounds';
import { adminSoundUploadKey, verifySoundUpload } from '../../../lib/s3-sounds';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    if (!adminDb) return NextResponse.json({ error: 'Sound catalog is not configured.' }, { status: 503 });
    const snapshot = await adminDb.collection('soundboardSounds').get();
    const origin = new URL(request.url).origin;
    const sounds = snapshot.docs
      .map(doc => soundResponse(doc.id, doc.data(), soundAudioUrl(origin, doc.id)))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ sounds });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load sounds.' }, { status: 401 });
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    if (!adminDb) return NextResponse.json({ error: 'Sound catalog is not configured.' }, { status: 503 });
    const body = await request.json() as Record<string, unknown>;
    const fields = soundFields(body);
    const soundKey = adminSoundUploadKey(body.soundKey);
    await verifySoundUpload(soundKey);
    const collection = adminDb.collection('soundboardSounds');
    const existing = await collection.get();
    const color = soundColor(body.color, existing.size);
    const ref = collection.doc(crypto.randomUUID());
    const record = { ...fields, color, soundKey, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
    await ref.set(record);
    const origin = new URL(request.url).origin;
    return NextResponse.json(soundResponse(ref.id, { ...record, createdAt: null }, soundAudioUrl(origin, ref.id)), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not add sound.' }, { status: 400 });
  }
}
