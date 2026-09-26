import { NextResponse } from 'next/server';
import { requirePlayer } from '../../../../../lib/player-auth';
import { createVideoTranscodeJob, finalizeVideoTranscode, getVideoTranscodeJob, headVideoObject, VIDEO_UPLOAD_LIMIT } from '../../../../../lib/video-transcoding.mjs';

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Cache-Control': 'no-store' };
export function OPTIONS() { return new NextResponse(null, { headers }); }

function validKeys(sourceKey: unknown, videoKey: unknown, owner: string) {
  if (typeof sourceKey !== 'string' || typeof videoKey !== 'string') return false;
  const prefix = `video-upload-staging/${owner}/`;
  if (!sourceKey.startsWith(prefix)) return false;
  const match = /^([a-f0-9-]{36})\.(mp4|webm|mov)$/i.exec(sourceKey.slice(prefix.length));
  return Boolean(match && videoKey === `videos/${owner}/${match[1]}.mp4`);
}

export async function POST(request: Request) {
  try {
    const player = await requirePlayer(request);
    const body = await request.json();
    if (!validKeys(body.sourceKey, body.videoKey, player.id)) throw new Error('Invalid video upload.');
    const source = await headVideoObject(body.sourceKey);
    if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(source.ContentType ?? '')) throw new Error('Use an MP4, WebM, or MOV video.');
    if (!source.ContentLength || source.ContentLength > VIDEO_UPLOAD_LIMIT) throw new Error('Videos must be 200 MB or smaller.');
    const job = await createVideoTranscodeJob({ sourceKey: body.sourceKey, videoKey: body.videoKey, owner: player.id, sourceEtag: source.ETag });
    return NextResponse.json({ jobId: job.jobId }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not start video compression.' }, { status: 400, headers });
  }
}

export async function GET(request: Request) {
  try {
    const player = await requirePlayer(request);
    const jobId = new URL(request.url).searchParams.get('jobId');
    if (!jobId || jobId.length > 128) throw new Error('Invalid compression job.');
    const job = await getVideoTranscodeJob(jobId);
    const metadata = job.UserMetadata ?? {};
    if (metadata.ambatuOwner !== player.id || typeof metadata.ambatuSourceKey !== 'string' || typeof metadata.ambatuVideoKey !== 'string' || typeof metadata.ambatuStageKey !== 'string') throw new Error('Compression job not found.');
    if (!validKeys(metadata.ambatuSourceKey, metadata.ambatuVideoKey, player.id)) throw new Error('Compression job not found.');
    if (job.Status === 'COMPLETE') {
      const result = await finalizeVideoTranscode({ sourceKey: metadata.ambatuSourceKey, videoKey: metadata.ambatuVideoKey, stageKey: metadata.ambatuStageKey });
      return NextResponse.json({ status: job.Status, videoKey: result.videoKey }, { headers });
    }
    return NextResponse.json({ status: job.Status, error: job.ErrorMessage }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not check video compression.' }, { status: 400, headers });
  }
}
