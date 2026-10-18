import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../lib/firebase-admin';
import { playerFromRequest } from '../../../../../lib/player-auth';
import { allowPlayerWrite } from '../../../../../lib/public-write-limits';
import { contributionHeaders } from '../../../../../lib/community-content';

export const runtime = 'nodejs';

const playerIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function OPTIONS() {
  return new NextResponse(null, { headers: contributionHeaders });
}

export async function POST(request: Request) {
  if (!adminDb) return NextResponse.json({ error: 'View service is not configured.' }, { status: 503, headers: contributionHeaders });

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid view.' }, { status: 400, headers: contributionHeaders });
  }

  const kind = body.kind;
  const id = body.id;
  const visitorId = body.visitorId;
  if ((kind !== 'lore' && kind !== 'character') || typeof id !== 'string' || !playerIdPattern.test(id)
    || typeof visitorId !== 'string' || !playerIdPattern.test(visitorId)) {
    return NextResponse.json({ error: 'Invalid view.' }, { status: 400, headers: contributionHeaders });
  }

  let player: Awaited<ReturnType<typeof playerFromRequest>> = null;
  if (request.headers.has('authorization')) {
    try {
      player = await playerFromRequest(request);
    } catch {
      return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401, headers: contributionHeaders });
    }
  }

  const identity = player ? `player:${player.id}` : `guest:${visitorId}`;
  if (!await allowPlayerWrite(adminDb, identity, 'creatorViews', [{ key: 'minute', max: 60, windowMs: 60_000 }])) {
    return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429, headers: contributionHeaders });
  }

  const collection = kind === 'lore' ? 'lores' : 'characters';
  const content = adminDb.collection(collection).doc(id);
  const viewKey = createHash('sha256').update(identity).digest('hex');
  const visitor = content.collection('creatorViews').doc(viewKey);

  try {
    const counted = await adminDb.runTransaction(async (transaction) => {
      const [contentSnapshot, visitorSnapshot] = await Promise.all([
        transaction.get(content),
        transaction.get(visitor),
      ]);
      const data = contentSnapshot.data();
      if (!contentSnapshot.exists || !data || data.status !== 'Published' || data.source !== 'revamp'
        || typeof data.uploaderId !== 'string' || player?.id === data.uploaderId) return false;
      if (visitorSnapshot.exists) return false;
      transaction.create(visitor, { viewedAt: FieldValue.serverTimestamp() });
      transaction.update(content, { viewCount: FieldValue.increment(1) });
      return true;
    });
    return NextResponse.json({ counted }, { headers: contributionHeaders });
  } catch {
    return NextResponse.json({ error: 'Could not record this view.' }, { status: 503, headers: contributionHeaders });
  }
}
