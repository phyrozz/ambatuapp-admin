import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/api-auth';
import { adminErrorStatus } from '../../../../lib/studio-api';
import { createSoundUpload } from '../../../../lib/s3-sounds';
import { studioContentOwner } from '../../../../lib/studio-content';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);
    const body = await request.json();
    return NextResponse.json(await createSoundUpload(body.fileName, body.contentType, body.size, studioContentOwner(actor)));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not prepare the audio upload.' }, { status: adminErrorStatus(error, 400) });
  }
}
