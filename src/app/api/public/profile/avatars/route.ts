import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../../lib/player-auth';
import { profileAvatarUrl } from '../../../../../lib/profile-avatars';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function GET(request: Request) {
  try {
    await requirePlayer(request);
    if (!adminDb) return NextResponse.json({ avatars: [] }, { headers });
    const snapshot = await adminDb.collection('profileAvatars').orderBy('createdAt', 'desc').get();
    const avatars = await Promise.all(snapshot.docs.map(async doc => ({ id: doc.id, name: doc.data().name ?? 'Dreamy avatar', imageUrl: await profileAvatarUrl(doc.data().imageKey) })));
    return NextResponse.json({ avatars }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load profile avatars.' }, { status: 401, headers });
  }
}
