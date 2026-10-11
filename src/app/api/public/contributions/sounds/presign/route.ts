import { NextResponse } from "next/server";
import {
  contributionBody,
  contributionError,
  contributionHeaders,
  contributionPlayer,
  limitContribution,
} from "../../../../../../lib/community-content";
import { createSoundUpload } from "../../../../../../lib/s3-sounds";

export const runtime = "nodejs";
export function OPTIONS() {
  return new NextResponse(null, { headers: contributionHeaders });
}

export async function POST(request: Request) {
  try {
    const player = await contributionPlayer(request);
    const body = await contributionBody(request);
    await limitContribution(player.id, "sound-upload", 20);
    const upload = await createSoundUpload(
      body.fileName,
      body.contentType,
      body.size,
      `player_${player.id}`,
    );
    return NextResponse.json(upload, { headers: contributionHeaders });
  } catch (error) {
    return contributionError(error);
  }
}
