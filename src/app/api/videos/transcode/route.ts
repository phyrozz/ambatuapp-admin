import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/api-auth';
import { adminErrorStatus } from '../../../../lib/studio-api';
import { createVideoTranscodeJob, finalizeVideoTranscode, getVideoTranscodeJob, headVideoObject, VIDEO_UPLOAD_LIMIT } from '../../../../lib/video-transcoding.mjs';
import { studioContentOwner } from '../../../../lib/studio-content';

export const runtime = 'nodejs';

function validKeys(sourceKey: unknown, videoKey: unknown, owner: string) {
  if (typeof sourceKey !== 'string' || typeof videoKey !== 'string') return false;
  const match = /^video-upload-staging\/([A-Za-z0-9_-]+)\/([a-f0-9-]{36})\.(mp4|webm|mov)$/i.exec(sourceKey);
  return Boolean(match && match[1] === owner && videoKey === `videos/${owner}/${match[2]}.mp4`);
}

export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);
    const owner = studioContentOwner(actor);
    const body = await request.json();
    if (!validKeys(body.sourceKey, body.videoKey, owner)) throw new Error('Invalid video upload.');
    const source = await headVideoObject(body.sourceKey);
    if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(source.ContentType ?? '')) throw new Error('Use an MP4, WebM, or MOV video.');
    if (!source.ContentLength || source.ContentLength > VIDEO_UPLOAD_LIMIT) throw new Error('Videos must be 200 MB or smaller.');
    const job = await createVideoTranscodeJob({ sourceKey: body.sourceKey, videoKey: body.videoKey, owner, sourceEtag: source.ETag });
    return NextResponse.json({ jobId: job.jobId });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not start video compression.' }, { status: adminErrorStatus(error, 400) });
  }
}

export async function GET(request: Request) {
  try {
    const actor = await requireAdmin(request);
    const owner = studioContentOwner(actor);
    const jobId = new URL(request.url).searchParams.get('jobId');
    if (!jobId || jobId.length > 128) throw new Error('Invalid compression job.');
    const job = await getVideoTranscodeJob(jobId);
    const metadata = job.UserMetadata ?? {};
    if (metadata.ambatuOwner !== owner || typeof metadata.ambatuSourceKey !== 'string' || typeof metadata.ambatuVideoKey !== 'string' || typeof metadata.ambatuStageKey !== 'string') throw new Error('Compression job not found.');
    if (!validKeys(metadata.ambatuSourceKey, metadata.ambatuVideoKey, owner)) throw new Error('Compression job not found.');
    if (job.Status === 'COMPLETE') {
      const result = await finalizeVideoTranscode({ sourceKey: metadata.ambatuSourceKey, videoKey: metadata.ambatuVideoKey, stageKey: metadata.ambatuStageKey });
      return NextResponse.json({ status: job.Status, videoKey: result.videoKey });
    }
    return NextResponse.json({ status: job.Status, error: job.ErrorMessage });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not check video compression.' }, { status: adminErrorStatus(error, 400) });
  }
}
