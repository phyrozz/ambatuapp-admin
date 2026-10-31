import { NextResponse } from 'next/server';
import { isDevSoundWriter } from '../../../../../../lib/dev-content-db';
import { publicSoundKey } from '../../../../../../lib/dev-sounds';
import { adminDb } from '../../../../../../lib/firebase-admin';
import { isPublicSound } from '../../../../../../lib/admin-sounds';
import { signedSoundUrl, validSoundAssetKey } from '../../../../../../lib/s3-sounds';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || (!adminDb && !isDevSoundWriter())) return new NextResponse(null, { status: 404 });
  try {
    if (isDevSoundWriter()) {
      const key = await publicSoundKey(id);
      if (!key) return new NextResponse(null, { status: 404 });
      return NextResponse.redirect(await signedSoundUrl(key), { status: 302, headers: { 'Cache-Control': 'no-store' } });
    }
    const snapshot = await adminDb!.collection('soundboardSounds').doc(id).get();
    const data = snapshot.data();
    const soundKey = data?.soundKey;
    if (!snapshot.exists || !data || !isPublicSound(data) || !validSoundAssetKey(soundKey)) return new NextResponse(null, { status: 404 });
    return NextResponse.redirect(await signedSoundUrl(soundKey), { status: 302, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return new NextResponse(null, { status: 503 });
  }
}
