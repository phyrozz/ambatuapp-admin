import { FieldPath } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { adminDb } from '../../../../lib/firebase-admin';
import { characterImageKey, signedCharacterImageUrl } from '../../../../lib/s3-images';

export const runtime = 'nodejs';
const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' };

function characterFromDocument(id: string, data: Record<string, unknown>) {
  const imageKey = characterImageKey(
    typeof data.imageKey === 'string' ? data.imageKey : undefined,
    typeof data.image === 'string' ? data.image : undefined,
  );
  return {
    id,
    name: data.name,
    title: data.title ?? '',
    bio: data.bio ?? data.description ?? '',
    tags: Array.isArray(data.tags) ? data.tags : [],
    imageKey,
  };
}

export async function GET(request: Request) {
  if (!adminDb) return NextResponse.json({ error: 'Character service is not configured.' }, { status: 503, headers });
  const url = new URL(request.url);
  const paginated = url.searchParams.has('limit') || url.searchParams.has('cursor');
  const requestedLimit = Number(url.searchParams.get('limit')) || 12;
  const limit = Math.min(50, Math.max(1, Math.floor(requestedLimit)));
  const search = (url.searchParams.get('q') ?? '').trim().toLowerCase();

  if (!paginated) {
    const snapshot = await adminDb.collection('characters').where('status', '==', 'Published').get();
    const characters = await Promise.all(snapshot.docs.map(async doc => {
      const character = characterFromDocument(doc.id, doc.data());
      const { imageKey, ...publicCharacter } = character;
      return { ...publicCharacter, imageUrl: await signedCharacterImageUrl(imageKey) };
    }));
    return NextResponse.json({ characters: characters.sort((a, b) => String(a.name).localeCompare(String(b.name))) }, { headers });
  }

  const cursorKey = JSON.stringify({ search, limit });
  const encodedCursor = url.searchParams.get('cursor');
  let cursor: { name: string; id: string } | null = null;
  if (encodedCursor) {
    try {
      const parsed = JSON.parse(Buffer.from(encodedCursor, 'base64url').toString('utf8')) as Record<string, unknown>;
      if (parsed.key !== cursorKey || typeof parsed.name !== 'string' || typeof parsed.id !== 'string') throw new Error('Invalid cursor');
      cursor = { name: parsed.name, id: parsed.id };
    } catch {
      return NextResponse.json({ error: 'Invalid character cursor.' }, { status: 400, headers });
    }
  }

  const collection = adminDb.collection('characters');
  const matches: Array<{ id: string; name: string; data: Record<string, unknown> }> = [];
  let scanAfter = cursor;
  while (matches.length <= limit) {
    let query = collection.orderBy('name').orderBy(FieldPath.documentId()).limit(limit + 1);
    if (scanAfter) query = query.startAfter(scanAfter.name, scanAfter.id);
    const snapshot = await query.get();
    if (!snapshot.docs.length) {
      break;
    }
    for (const doc of snapshot.docs) {
      const data = doc.data();
      scanAfter = typeof data.name === 'string' ? { name: data.name, id: doc.id } : scanAfter;
      if (data.status !== 'Published' || typeof data.name !== 'string' || !data.name.trim()) continue;
      if (search && !data.name.toLowerCase().includes(search)) continue;
      matches.push({ id: doc.id, name: data.name, data });
      if (matches.length > limit) break;
    }
    if (matches.length > limit) break;
    if (snapshot.docs.length < limit + 1) break;
  }

  const page = matches.slice(0, limit);
  const characters = await Promise.all(page.map(async item => {
    const character = characterFromDocument(item.id, item.data);
    const { imageKey, ...publicCharacter } = character;
    return { ...publicCharacter, imageUrl: await signedCharacterImageUrl(imageKey) };
  }));
  const last = page.at(-1);
  const nextCursor = matches.length > limit && last
    ? Buffer.from(JSON.stringify({ key: cursorKey, name: last.name, id: last.id })).toString('base64url')
    : null;
  return NextResponse.json({ characters, nextCursor }, { headers });
}
