import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { isDevVideoWriter } from '../../../lib/dev-content-db';
import { createStudioVideo, listStudioVideos } from '../../../lib/dev-videos';
import { requireAdmin } from '../../../lib/api-auth';
import { adminErrorStatus } from '../../../lib/studio-api';
import { adminDb } from '../../../lib/firebase-admin';
import { adminUploadKeys, hydrateVideo, videoFields } from '../../../lib/admin-video';
import { headVideoObject, VIDEO_COMPRESSION_VERSION } from '../../../lib/video-transcoding.mjs';
import { isStudioRoot, studioContentOwner } from '../../../lib/studio-content';
import { characterListFilter, encodeCharacterListCursor, parseCharacterListCursor } from '../../../lib/character-list-pagination';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const actor = await requireAdmin(request);
    if (!adminDb && !isDevVideoWriter()) return NextResponse.json({ error: 'Video service is not configured.' }, { status: 503 });
    if (isDevVideoWriter()) return NextResponse.json(await listStudioVideos(actor, new URL(request.url)));
    const url = new URL(request.url), filter = characterListFilter(url, isStudioRoot(actor) ? null : actor!.sub);
    let after = parseCharacterListCursor(url.searchParams.get('cursor'), filter);
    const matches: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    while (matches.length <= filter.limit) {
      let query: FirebaseFirestore.Query = adminDb!.collection('videos');
      if (filter.owner) query = query.where('createdBy', '==', filter.owner);
      query = query.orderBy(FieldPath.documentId()).limit(filter.limit + 1);
      if (after) query = query.startAfter(after);
      const snapshot = await query.get();
      if (!snapshot.docs.length) break;
      for (const doc of snapshot.docs) {
        after = doc.id;
        const data = doc.data(), text = [data.title, data.description, data.uploaderEmail].join(' ').toLowerCase();
        if ((filter.status && data.status !== filter.status) || (filter.query && !text.includes(filter.query))) continue;
        matches.push(doc);
        if (matches.length > filter.limit) break;
      }
      if (matches.length > filter.limit || snapshot.docs.length < filter.limit + 1) break;
    }
    const page = matches.slice(0, filter.limit), last = page.at(-1);
    const videos = await Promise.all(page.map(doc => hydrateVideo(doc.id, doc.data())));
    return NextResponse.json({ videos, nextCursor: matches.length > filter.limit && last ? encodeCharacterListCursor(last.id, filter) : null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load videos.' }, { status: adminErrorStatus(error, 401) });
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);
    if (!adminDb && !isDevVideoWriter()) return NextResponse.json({ error: 'Video service is not configured.' }, { status: 503 });
    const body = await request.json();
    const fields = videoFields(body);
    const owner = studioContentOwner(actor);
    const keys = adminUploadKeys(body, owner);
    const uploadedVideo = await headVideoObject(keys.videoKey);
    if (uploadedVideo.Metadata?.['ambatu-compression'] !== VIDEO_COMPRESSION_VERSION || uploadedVideo.ContentType !== 'video/mp4') throw new Error('Wait for video compression to finish.');
    if (isDevVideoWriter()) return NextResponse.json(await createStudioVideo(actor, fields, keys), { status: 201 });
    const stored = { ...fields, ...keys, uploaderEmail: actor?.email ?? 'Ambatu Admin', uploaderName: actor?.profile?.displayName ?? 'Ambatu Admin', uploaderId: 'admin', ...(actor ? { createdBy: actor.sub } : {}), upvotes: 0, downvotes: 0, commentCount: 0, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
    const ref = await adminDb!.collection('videos').add(stored);
    return NextResponse.json(await hydrateVideo(ref.id, (await ref.get()).data() ?? {}), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not create video.' }, { status: adminErrorStatus(error, 400) });
  }
}
