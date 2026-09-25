import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../lib/firebase-admin';
import { requirePlayer } from '../../../../../lib/player-auth';
import { profileAvatarUrl } from '../../../../../lib/profile-avatars';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};

export function OPTIONS() { return new NextResponse(null, { headers }); }

export async function POST(request: Request) {
  try {
    await requirePlayer(request);
  } catch {
    return NextResponse.json({ error: 'Sign in required.' }, { status: 401, headers });
  }
  if (!adminDb) return NextResponse.json({ error: 'Player profiles are unavailable.' }, { status: 503, headers });
  try {
    const body = await request.json();
    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))) {
      return NextResponse.json({ error: 'Invalid player IDs.' }, { status: 400, headers });
    }
    const unique = [...new Set<string>(ids)];
    const refs = unique.map(id => adminDb!.collection('playerProfiles').doc(id));
    const docs = refs.length ? await adminDb.getAll(...refs) : [];
    const names: Record<string, string> = {};
    const avatars: Record<string, string> = {};
    await Promise.all(docs.map(async (doc, index) => {
      const username = doc.data()?.username;
      const id = unique[index];
      if (typeof username === 'string' && username.trim()) names[id] = username;
      const avatarUrl = await profileAvatarUrl(typeof doc.data()?.avatarKey === 'string' ? doc.data()!.avatarKey : undefined);
      if (avatarUrl) avatars[id] = avatarUrl;
    }));
    return NextResponse.json({ names, avatars }, { headers });
  } catch {
    return NextResponse.json({ error: 'Could not load player names.' }, { status: 500, headers });
  }
}
