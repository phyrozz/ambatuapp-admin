import { NextResponse } from "next/server";
import {
  contributionBody,
  contributionError,
  contributionHeaders,
  contributionPlayer,
  limitContribution,
} from "../../../../../../../lib/community-content";
import { createPlayerLoreImageUpload } from "../../../../../../../lib/s3-images";

export const runtime = "nodejs";
export function OPTIONS() {
  return new NextResponse(null, { headers: contributionHeaders });
}

export async function POST(request: Request) {
  try {
    const player = await contributionPlayer(request);
    const body = await contributionBody(request);
    if (typeof body.submissionId !== "string")
      throw new Error("Invalid lore image destination.");
    await limitContribution(player.id, "lore-image-upload", 40);
    return NextResponse.json(
      await createPlayerLoreImageUpload(
        player.id,
        body.submissionId,
        body.contentType,
        body.size,
      ),
      { headers: contributionHeaders },
    );
  } catch (error) {
    return contributionError(error);
  }
}
