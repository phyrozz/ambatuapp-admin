import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/api-auth';
import { createSoundUpload } from '../../../../lib/s3-sounds';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = await request.json();
    return NextResponse.json(await createSoundUpload(body.fileName, body.contentType, body.size));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not prepare the audio upload.' }, { status: 400 });
  }
}
