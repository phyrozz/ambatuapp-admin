import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../../lib/firebase-admin';
import { signedSoundUrl, validSoundAssetKey } from '../../../../../../lib/s3-sounds';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !adminDb) return new NextResponse(null, { status: 404 });
  try {
    const snapshot = await adminDb.collection('soundboardSounds').doc(id).get();
    const soundKey = snapshot.data()?.soundKey;
    if (!snapshot.exists || !validSoundAssetKey(soundKey)) return new NextResponse(null, { status: 404 });
    return NextResponse.redirect(await signedSoundUrl(soundKey), { status: 302, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return new NextResponse(null, { status: 503 });
  }
}
